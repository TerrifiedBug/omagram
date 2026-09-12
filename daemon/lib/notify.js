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

// The systemd user service inherits a minimal PATH that omits Omarchy's own
// bin directory, so look there directly. Without the Omarchy helper the toast
// still appears through notify-send, but clicking it cannot open the chat.
const omarchySend = [
  process.env.OMARCHY_PATH ? join(process.env.OMARCHY_PATH, 'bin', 'omarchy-notification-send') : '',
  '/usr/share/omarchy/bin/omarchy-notification-send'
].filter(Boolean).find((path) => existsSync(path)) || findCommand('omarchy-notification-send')

const notifySend = findCommand('notify-send')
const useOmarchy = !!omarchySend
const canNotify = useOmarchy || !!notifySend

function hasCommand(name) {
  return !!findCommand(name)
}

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

  // Drop everything still buffered — used when the user opens the chat before
  // the coalesce window closes, so reading a chat cancels its pending toast.
  cancel(chatId) {
    const entry = this.pending.get(chatId)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(chatId)
  }

  cancelAll() {
    for (const chatId of [...this.pending.keys()]) this.cancel(chatId)
  }

  send(title, body, chatId) {
    if (!this.enabled) return
    const args = useOmarchy
      ? ['--app-name', 'OmaGram', '-u', 'normal', '-g', GLYPH, title, body]
      : ['-a', 'OmaGram', '-u', 'normal', `--hint=string:omarchy-glyph:${GLYPH}`, title, body]

    // Clicking the toast opens the bar panel on the originating chat.
    // omarchy-notification-send takes `--exec <program> [args...]` as argv and
    // only after the headline and description, so the chat id needs no quoting
    // and the flag cannot come earlier.
    if (useOmarchy && chatId) args.push('--exec', 'bash', focusPath, String(chatId))

    const command = useOmarchy ? omarchySend : notifySend
    try {
      const child = spawn(command, args, { stdio: 'ignore', detached: true })
      child.on('error', (err) => logger.warn({ err }, 'notify: spawn failed'))
      // A rejected argument list used to fail silently here, which is how the
      // whole toast path stayed broken.
      child.on('exit', (code) => {
        if (code) logger.warn({ command, code }, 'notify: helper exited non-zero')
      })
      child.unref()
    } catch (err) {
      logger.warn({ err }, 'notify: spawn threw')
    }
  }
}
