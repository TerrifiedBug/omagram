import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { logger } from './logger.js'

// nf-fa-telegram. Omarchy's notification service renders this through the
// `omarchy-glyph` hint, matching the bar widget's icon.
const GLYPH = '\uf2c6'

// Messages arrive in bursts. Holding a chat's notification briefly lets a
// three-message burst land as one toast instead of three stacked ones.
const COALESCE_MS = 1200

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const focusPath = join(pluginRoot, 'bin', 'omarchy-omagram-focus')

function findCommand(name) {
  const dirs = (process.env.PATH || '').split(':').filter(Boolean)
  const hit = dirs.find((dir) => existsSync(join(dir, name)))
  return hit ? join(hit, name) : ''
}

function hasCommand(name) {
  return !!findCommand(name)
}

// Toasts go through plain `notify-send` with a libnotify action rather than
// `omarchy-notification-send`, because the click has to work whichever
// notification server is running. The Omarchy helper's `omarchy-exec-argv`
// hint is only read by Omarchy's own notifications plugin; a bar that replaces
// it (omapager, for one) invokes a standard action named `default` and ignores
// the hint, which makes a hint-only toast silently unclickable.
//
// `-A` implies `--wait`, so the process lives until the toast is activated or
// dismissed and prints the chosen action name on stdout. That is the "sender
// must stay alive" part of the libnotify action contract.
const notifySend = findCommand('notify-send')
const canNotify = !!notifySend

const soundPlayer = ['paplay', 'pw-play', 'canberra-gtk-play'].find((name) => hasCommand(name))
const soundFile = [
  '/usr/share/sounds/freedesktop/stereo/message-new-instant.oga',
  '/usr/share/sounds/freedesktop/stereo/message.oga'
].find((path) => existsSync(path))

export class Notifier {
  constructor() {
    this.enabled = canNotify && process.env.OMARCHY_OMAGRAM_NO_NOTIFY !== '1'
    /** @type {Map<string, {title: string, lines: string[], timer: NodeJS.Timeout}>} */
    this.pending = new Map()
    // One `notify-send --wait` child per visible toast, kept so opening the
    // chat can take its toast down instead of leaving a stale one on screen.
    /** @type {Map<string, import('node:child_process').ChildProcess>} */
    this.live = new Map()
    if (!canNotify) logger.warn('notify: no notify-send on PATH, notifications disabled')
  }

  // Called once per incoming message. Preference checks happen at flush so a
  // message that auto-unarchives within the coalesce window can still alert.
  // Pass shouldNotify as a live predicate over store state.
  queue({ chatId, title, body, shouldNotify }) {
    if (!this.enabled) return
    const entry = this.pending.get(chatId)
    if (entry) {
      entry.title = title
      entry.lines.push(body)
      if (shouldNotify) entry.shouldNotify = shouldNotify
      return
    }
    const fresh = { title, lines: [body], timer: null, shouldNotify }
    fresh.timer = setTimeout(() => this.flush(chatId), COALESCE_MS)
    fresh.timer.unref?.()
    this.pending.set(chatId, fresh)
  }

  flush(chatId) {
    const entry = this.pending.get(chatId)
    if (!entry) return
    this.pending.delete(chatId)
    clearTimeout(entry.timer)

    if (typeof entry.shouldNotify === 'function' && !entry.shouldNotify()) return

    const body = entry.lines.length > 1
      ? `${entry.lines[entry.lines.length - 1]}\n(+${entry.lines.length - 1} more)`
      : entry.lines[0]
    this.send(entry.title, body, chatId)
    this.playSound()
  }

  playSound() {
    if (process.env.OMARCHY_OMAGRAM_NO_SOUND === '1') return
    if (!soundPlayer || !soundFile) return
    const args = soundPlayer === 'canberra-gtk-play' ? ['-f', soundFile] : [soundFile]
    try {
      const child = spawn(soundPlayer, args, { stdio: 'ignore', detached: true })
      child.on('error', (err) => logger.debug({ err }, 'notify: sound failed'))
      child.unref()
    } catch (err) {
      logger.debug({ err }, 'notify: sound threw')
    }
  }

  // Drop everything still buffered and take down anything already on screen.
  // Used when the user opens the chat, so reading it clears its toast.
  cancel(chatId) {
    const entry = this.pending.get(chatId)
    if (entry) {
      clearTimeout(entry.timer)
      this.pending.delete(chatId)
    }
    const child = this.live.get(chatId)
    if (child) {
      this.live.delete(chatId)
      child.kill('SIGTERM')
    }
  }

  cancelAll() {
    for (const chatId of [...this.pending.keys()]) this.cancel(chatId)
    for (const chatId of [...this.live.keys()]) this.cancel(chatId)
  }

  // Open the bar panel on the chat the toast came from.
  _activate(chatId) {
    try {
      const child = spawn('bash', [focusPath, String(chatId)], { stdio: 'ignore', detached: true })
      child.on('error', (err) => logger.warn({ err, chatId }, 'notify: focus failed'))
      child.unref()
    } catch (err) {
      logger.warn({ err, chatId }, 'notify: focus threw')
    }
  }

  send(title, body, chatId) {
    if (!this.enabled) return
    const args = [
      '-a', 'OmaGram',
      '-u', 'normal',
      `--hint=string:omarchy-glyph:${GLYPH}`,
      ...(chatId ? ['-A', 'default=Open'] : []),
      title,
      body
    ]

    let child
    try {
      child = spawn(notifySend, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch (err) {
      logger.warn({ err }, 'notify: spawn threw')
      return
    }
    child.on('error', (err) => logger.warn({ err }, 'notify: spawn failed'))

    if (!chatId) {
      child.unref()
      return
    }

    // Replace rather than stack: a second toast for the same chat supersedes
    // the first, and the old child would otherwise sit waiting forever.
    const previous = this.live.get(chatId)
    if (previous) previous.kill('SIGTERM')
    this.live.set(chatId, child)

    let chosen = ''
    child.stdout.on('data', (chunk) => { chosen += chunk.toString('utf8') })
    child.on('exit', (code, signal) => {
      if (this.live.get(chatId) === child) this.live.delete(chatId)
      if (signal) return
      if (code) {
        logger.warn({ code }, 'notify: notify-send exited non-zero')
        return
      }
      if (chosen.trim() === 'default') this._activate(chatId)
    })
  }
}
