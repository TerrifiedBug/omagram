import { chmodSync, readdirSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import QRCode from 'qrcode'

import { apiFile, ensureDirs, mediaDir, pidFile, qrPngFileFor, qrTxtFile, sessionFile, socketPath, stateDir } from './lib/paths.js'
import { logger } from './lib/logger.js'
import { Store } from './lib/store.js'
import { Notifier } from './lib/notify.js'
import { Bus } from './lib/server.js'
import { chatIdOf, displayName, isPhotoMedia, isService, messageButtons, messageText, messageType } from './lib/message.js'
import { existingMediaPath, MediaCache } from './lib/media.js'
import { Telegram } from './lib/telegram.js'
import {
  applyChatNotificationPreferences,
  isChatMuted,
  muteExpiryDelayMs,
  shouldNotifyChat
} from './lib/preferences.js'
import { watchPluginState as observePluginState } from './lib/plugin-state.js'

// Login does not run forever. Without this the daemon would keep refreshing a
// QR for an account that may never be linked.
const PAIRING_WINDOW_MS = Math.max(
  15000,
  Number(process.env.OMARCHY_OMAGRAM_PAIRING_WINDOW_MS) || 5 * 60 * 1000
)
// teleproto refreshes the QR token every 30s, so a 5 minute window is ten
// codes. The cap is the backstop for a window that somehow never closes.
const MAX_QR_PER_PAIRING = 16
const PRINT_QR = process.env.OMARCHY_OMAGRAM_PRINT_QR === '1'
const LIVENESS_INTERVAL_MS = 20000
// Node's setTimeout overflows above this, and Telegram's "mute forever" is a
// date decades out, so those chats simply never arm a timer.
const MAX_TIMER_MS = 2_147_483_647

// Messages predating this run are backlog, not news: the phone already
// notified them, so replaying them as toasts on every start would be noise.
const startedAt = Math.floor(Date.now() / 1000)

const MSG_PENDING = 1
const MSG_SENT = 2
const MSG_READ = 4

const store = new Store()
const notifier = new Notifier()
const media = new MediaCache()
const bus = new Bus(socketPath)
const tg = new Telegram({ sessionFile, apiFile })

let connection = 'idle'
let needsApi = true
let needsLogin = false
let hasQr = false
let qrVersion = 0
let currentQrPng = ''
let pairingStopped = true
let codeViaApp = false
let passwordHint = ''
let lastError = ''
let stopping = false
let connecting = false
let refreshInFlight = false
let chatsFlushTimer = null
let lastStateJson = ''
let qrCount = 0
let pairingTimer = null
let floodTimer = null
/** @type {{ resolve: (value: string) => void, reject: (err: Error) => void } | null} */
let pendingCode = null
let pendingPassword = null
/** @type {AbortController | null} */
let loginAbort = null
let loginRun = null

const wantedChats = new Set()
/** @type {Map<string, number>} */
const readOutboxMax = new Map()
/** @type {Map<string, NodeJS.Timeout>} */
const muteExpiryTimers = new Map()

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function clearMuteExpiry(chatId) {
  const timer = muteExpiryTimers.get(chatId)
  if (!timer) return
  clearTimeout(timer)
  muteExpiryTimers.delete(chatId)
}

// Timed mutes must refresh the bar badge when they elapse, even with no new
// Telegram event.
function scheduleMuteExpiry(chat) {
  if (!chat?.chatId) return
  clearMuteExpiry(chat.chatId)
  const delay = muteExpiryDelayMs(chat)
  if (delay === null) return
  if (delay === 0) {
    chat.muted = false
    return
  }
  if (delay > MAX_TIMER_MS) return
  const timer = setTimeout(() => {
    muteExpiryTimers.delete(chat.chatId)
    const current = store.chat(chat.chatId)
    if (!current || isChatMuted(current)) return
    current.muted = false
    store.markDirty()
    pushState()
    pushChatsSoon()
  }, delay)
  timer.unref?.()
  muteExpiryTimers.set(chat.chatId, timer)
}

function state() {
  return {
    t: 'state',
    connection,
    needsApi,
    needsLogin,
    hasQr,
    qrVersion,
    qrPng: hasQr ? currentQrPng : '',
    pairingStopped,
    codeViaApp,
    passwordHint,
    linked: !!store.me?.id,
    me: store.me,
    unread: store.totalUnread(),
    lastError,
    daemonPid: process.pid
  }
}

function snapshot() {
  return { ...state(), t: 'state', chats: store.chatList(60) }
}

function pushState() {
  const next = state()
  const key = JSON.stringify(next)
  if (key === lastStateJson) return
  lastStateJson = key
  bus.broadcast(next)
}

function pushChats(limit = 60) {
  bus.broadcast({ t: 'chats', chats: store.chatList(limit), unread: store.totalUnread() })
}

function pushChatsSoon() {
  if (chatsFlushTimer) return
  chatsFlushTimer = setTimeout(() => {
    chatsFlushTimer = null
    pushChats()
  }, 300)
  chatsFlushTimer.unref?.()
}

function setLastError(message) {
  lastError = message
  pushState()
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

// Saved Messages is the one chat where Telegram does not set `out` on a
// message you sent, so the sender id has to be compared against the account.
function isFromMe(raw) {
  if (raw.out) return true
  const me = store.me?.id
  if (!me) return false
  return raw.senderId ? String(raw.senderId) === me : false
}

/** Flatten a teleproto message into the shape the panel renders. */
function flatten(chatId, raw, senderName) {
  const id = String(raw.id)
  const fromMe = isFromMe(raw)
  const message = {
    id,
    ts: raw.date || Math.floor(Date.now() / 1000),
    fromMe,
    text: messageText(raw),
    type: messageType(raw),
    senderName: fromMe ? (store.me?.name || 'You') : senderName,
    status: fromMe ? (Number(id) <= (readOutboxMax.get(chatId) || 0) ? MSG_READ : MSG_SENT) : 0,
    imagePath: '',
    buttons: messageButtons(raw)
  }
  message.imagePath = existingMediaPath(message)
  return message
}

function notifyFor(chatId, chat, message) {
  const isGroup = chat.kind === 'group'
  const title = isGroup || chat.kind === 'channel' ? (chat.name || 'Telegram') : (message.senderName || chat.name)
  const body = isGroup && message.senderName ? `${message.senderName}: ${message.text}` : message.text
  logger.debug({ chatId, title }, 'notify: queued')
  notifier.queue({
    chatId,
    title,
    body,
    shouldNotify: () => shouldNotifyChat(store.chat(chatId))
  })
}

/**
 * Store a message and, when it arrived live, tell the panels and the user.
 * History backfill passes `live: false`: it must not toast or bump unread.
 * An edit is live but not new, so it updates the panel without alerting.
 */
function ingest(chatId, raw, senderName, live, edited = false) {
  if (isService(raw)) return null

  const message = flatten(chatId, raw, senderName)
  const existed = !!store.findMessage(chatId, message.id)
  store.upsertMessage(chatId, message)
  const chat = store.touchChat(chatId, message)

  logger.debug(
    { chatId, id: message.id, live, fromMe: message.fromMe, existed, ts: message.ts, startedAt },
    'ingest'
  )

  if (live && !edited && !existed && !message.fromMe) {
    // Telegram sends authoritative counts through readInbox, so a plain
    // increment here is enough and self-corrects.
    store.bumpUnread(chatId)
    if (message.ts >= startedAt) notifyFor(chatId, chat, message)
  }
  if (live && message.fromMe) store.setUnread(chatId, 0)

  if (live) {
    bus.broadcast({
      t: 'message',
      chatId,
      message,
      chat: store.chat(chatId),
      unread: store.totalUnread()
    })
  }

  if (!message.imagePath && isPhotoMedia(raw) && wantedChats.has(chatId)) {
    media.enqueue(chatId, message)
  }
  return message
}

function applyStatus(chatId, maxId) {
  const list = store.messages.get(chatId) || []
  let changed = false
  for (const message of list) {
    if (!message.fromMe) continue
    if (Number(message.id) > maxId) continue
    if ((message.status || 0) >= MSG_READ) continue
    message.status = MSG_READ
    changed = true
    bus.broadcast({ t: 'messageStatus', chatId, id: message.id, status: MSG_READ })
  }
  if (changed) store.markDirty()
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

function mergeDialog(entry) {
  const chat = store.chat(entry.chatId)
  chat.name = entry.name || chat.name
  chat.kind = entry.kind
  chat.isGroup = entry.isGroup
  chat.username = entry.username
  chat.archived = entry.archived
  chat.pinned = entry.pinned
  store.setUnread(entry.chatId, entry.unread)
  applyChatNotificationPreferences(chat, { muteEndTime: entry.muteUntil })
  readOutboxMax.set(entry.chatId, entry.readOutboxMaxId)

  if (entry.top) {
    const senderName = entry.top.out ? (store.me?.name || 'You') : (entry.topSender || entry.name || '')
    const message = flatten(entry.chatId, entry.top, senderName)
    store.upsertMessage(entry.chatId, message)
    store.touchChat(entry.chatId, message)
  }
  scheduleMuteExpiry(chat)
  if (!shouldNotifyChat(chat)) notifier.cancel(entry.chatId)
  return chat
}

async function refreshDialogs() {
  if (refreshInFlight || connection !== 'open') return false
  refreshInFlight = true
  try {
    for (const entry of await tg.dialogs()) mergeDialog(entry)
    store.markDirty()
    pushChats()
    pushState()
    return true
  } catch (err) {
    if (!tg.classifyError(err)) logger.warn({ err }, 'dialogs: refresh failed')
    return false
  } finally {
    refreshInFlight = false
  }
}

// ---------------------------------------------------------------------------
// Connection and login
// ---------------------------------------------------------------------------

function removeFile(path) {
  try {
    unlinkSync(path)
  } catch {
    // Nothing to clear.
  }
}

function clearQr() {
  hasQr = false
  if (currentQrPng) removeFile(currentQrPng)
  currentQrPng = ''
  removeFile(qrTxtFile)
}

async function writeQr(url) {
  if (pairingStopped) return
  qrCount += 1
  if (qrCount > MAX_QR_PER_PAIRING) {
    stopPairing('too many codes')
    return
  }

  const version = qrVersion + 1
  const target = qrPngFileFor(version)
  try {
    await QRCode.toFile(target, url, { margin: 2, width: 512, color: { dark: '#000000ff', light: '#ffffffff' } })
    // A readable QR is a linkable account, so keep it owner-only even though
    // the state directory is already 0700.
    chmodSync(target, 0o600)
    const terminal = await QRCode.toString(url, { type: 'terminal', small: true })
    writeFileSync(qrTxtFile, terminal, { mode: 0o600 })
    if (PRINT_QR) process.stdout.write(`\n${terminal}\n`)

    const previous = currentQrPng
    currentQrPng = target
    hasQr = true
    qrVersion = version
    connection = 'qr'
    needsLogin = true
    pushState()
    if (previous && previous !== target) removeFile(previous)
    logger.info('login: scan the QR from the OmaGram bar panel or run `omarchy-omagram login`')
  } catch (err) {
    logger.error({ err }, 'login: could not render QR')
  }
}

function rejectPending(reason) {
  const err = new Error(reason)
  if (pendingCode) {
    pendingCode.reject(err)
    pendingCode = null
  }
  if (pendingPassword) {
    pendingPassword.reject(err)
    pendingPassword = null
  }
}

// Stop refreshing and drop the QR rather than leave an expired code on screen
// pretending to be scannable. Login in the panel or `omarchy-omagram login`
// both reopen the window.
function stopPairing(reason) {
  if (pairingTimer) {
    clearTimeout(pairingTimer)
    pairingTimer = null
  }
  const shown = qrCount
  qrCount = 0
  pairingStopped = true
  codeViaApp = false
  passwordHint = ''
  rejectPending('login window closed')
  loginAbort?.abort()
  loginAbort = null
  loginRun = null
  clearQr()
  if (connection !== 'open') {
    connection = 'idle'
    needsLogin = true
  }
  logger.info({ qrCount: shown, reason }, 'login: window closed')
  pushState()
}

function onOpen() {
  connection = 'open'
  connecting = false
  needsLogin = false
  pairingStopped = true
  codeViaApp = false
  passwordHint = ''
  qrCount = 0
  if (pairingTimer) {
    clearTimeout(pairingTimer)
    pairingTimer = null
  }
  loginAbort = null
  loginRun = null
  clearQr()
  if (tg.me) store.me = { id: chatIdOf(tg.me), name: displayName(tg.me) }
  lastError = ''
  pushState()
  refreshDialogs()
}

function onUnauthorized() {
  tg.dropSession()
  needsLogin = true
  connection = 'idle'
  connecting = false
  pushState()
}

async function connect() {
  if (connecting || stopping || connection === 'open') return
  if (needsApi) {
    needsLogin = true
    connection = 'idle'
    pushState()
    return
  }
  connecting = true
  connection = 'connecting'
  pushState()
  try {
    await tg.connect()
  } catch (err) {
    connecting = false
    connection = 'idle'
    if (!tg.classifyError(err)) {
      setLastError(String(err?.errorMessage || err?.message || err))
      logger.error({ err }, 'connection: connect failed')
    }
    pushState()
  }
}

function deferred(slot) {
  return new Promise((resolve, reject) => {
    const box = { resolve, reject }
    if (slot === 'code') pendingCode = box
    else pendingPassword = box
  })
}

function onNeedPassword(hint) {
  connection = 'password'
  passwordHint = hint || ''
  pushState()
  return deferred('password')
}

function onNeedCode(viaApp) {
  connection = 'code'
  codeViaApp = !!viaApp
  pushState()
  return deferred('code')
}

async function startLogin(mode, phone) {
  if (needsApi) throw new Error('login: api credentials required')
  if (connection === 'open') return { already: true }
  if (loginRun) stopPairing('restarted')

  loginAbort = new AbortController()
  const signal = loginAbort.signal
  pairingStopped = false
  qrCount = 0
  lastError = ''
  connection = mode === 'qr' ? 'qr' : 'code'
  hasQr = false
  needsLogin = true
  pushState()

  pairingTimer = setTimeout(() => {
    pairingTimer = null
    if (connection !== 'open') stopPairing('timeout')
  }, PAIRING_WINDOW_MS)
  pairingTimer.unref?.()

  const run = mode === 'qr'
    ? tg.loginQr({ onQr: writeQr, onPassword: onNeedPassword, signal })
    : tg.loginPhone({ phone, onCode: onNeedCode, onPassword: onNeedPassword, signal })
  loginRun = run

  run.then(() => {
    // onOpen fires from the `open` event, which _afterAuth emits.
  }).catch((err) => {
    if (loginRun !== run) return
    loginRun = null
    if (err?.name === 'AbortError' || signal.aborted) return
    connection = 'idle'
    needsLogin = true
    pairingStopped = true
    clearQr()
    setLastError(String(err?.errorMessage || err?.message || err))
    logger.warn({ err }, 'login: failed')
  })

  return { already: false }
}

function onRevoked() {
  logger.warn('session revoked by Telegram')
  tg.disconnect().catch(() => {})
  tg.dropSession()
  store.clear()
  readOutboxMax.clear()
  needsLogin = true
  connection = 'idle'
  connecting = false
  lastError = 'Session revoked by Telegram'
  pushState()
  pushChats()
}

function onFlood(seconds) {
  logger.warn({ seconds }, 'rate limited by Telegram')
  lastError = `Rate limited by Telegram, retrying in ${seconds}s`
  pushState()
  clearTimeout(floodTimer)
  floodTimer = setTimeout(() => {
    floodTimer = null
    if (lastError.startsWith('Rate limited by Telegram')) setLastError('')
  }, Math.max(1000, seconds * 1000))
  floodTimer.unref?.()
}

function wireTelegram() {
  tg.on('open', onOpen)
  tg.on('unauthorized', onUnauthorized)
  tg.on('revoked', onRevoked)
  tg.on('flood', onFlood)
  tg.on('passwordRejected', () => {
    pendingPassword = null
    setLastError('Wrong password')
  })
  tg.on('codeRejected', () => {
    pendingCode = null
    setLastError('Wrong code')
  })
  tg.on('error', (err) => {
    logger.warn({ err }, 'telegram: auth error')
    setLastError(String(err?.errorMessage || err?.message || err))
  })

  tg.on('message', ({ chatId, raw, senderName }) => {
    const before = store.totalUnread()
    if (!ingest(chatId, raw, senderName, true)) return
    pushChatsSoon()
    if (store.totalUnread() !== before) pushState()
  })

  tg.on('edited', ({ chatId, raw, senderName }) => {
    if (ingest(chatId, raw, senderName, true, true)) pushChatsSoon()
  })

  tg.on('readInbox', ({ chatId, unread }) => {
    store.setUnread(chatId, unread)
    notifier.cancel(chatId)
    pushChatsSoon()
    pushState()
  })

  tg.on('readOutbox', ({ chatId, maxId }) => {
    readOutboxMax.set(chatId, Math.max(maxId, readOutboxMax.get(chatId) || 0))
    applyStatus(chatId, maxId)
  })

  tg.on('notify', ({ chatId, muteUntil }) => {
    const chat = store.chat(chatId)
    applyChatNotificationPreferences(chat, { muteEndTime: muteUntil })
    scheduleMuteExpiry(chat)
    if (!shouldNotifyChat(chat)) notifier.cancel(chatId)
    store.markDirty()
    pushChatsSoon()
    pushState()
  })

  tg.on('pinned', ({ chatId, pinned }) => {
    store.chat(chatId).pinned = pinned
    store.markDirty()
    pushChatsSoon()
  })

  tg.on('folder', ({ chatId, archived }) => {
    const chat = store.chat(chatId)
    chat.archived = archived
    if (archived) notifier.cancel(chatId)
    store.markDirty()
    pushChatsSoon()
    pushState()
  })
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function markRead(chatId) {
  notifier.cancel(chatId)
  store.setUnread(chatId, 0)
  pushChats()
  pushState()
  if (connection !== 'open') return
  try {
    await tg.markRead(chatId)
  } catch (err) {
    if (!tg.classifyError(err)) logger.debug({ err, chatId }, 'read receipts failed')
  }
}

async function loadHistory(chatId, limit) {
  if (connection !== 'open') return
  try {
    for (const raw of await tg.history(chatId, limit)) {
      const senderName = raw.out ? (store.me?.name || 'You') : displayName(raw.sender)
      ingest(chatId, raw, senderName, false)
    }
    store.markDirty()
  } catch (err) {
    if (err?.message === 'unknown chat') throw err
    if (!tg.classifyError(err)) logger.debug({ err, chatId }, 'history fetch failed')
  }
}

function replyMessages(chatId, limit, reply) {
  const list = store.messageList(chatId, limit)
  reply({ t: 'messages', chatId, chat: store.chat(chatId), messages: list })
  for (const message of list) {
    if (!message.imagePath && message.type === 'photo') media.enqueue(chatId, message)
  }
}

async function handleCommand(payload, reply) {
  const { t, id } = payload
  switch (t) {
    case 'hello':
      reply(snapshot())
      return

    case 'ping':
      reply({ t: 'pong', id })
      return

    case 'chats':
      reply({ t: 'chats', chats: store.chatList(payload.limit || 60), unread: store.totalUnread() })
      return

    case 'refresh': {
      const limit = payload.limit || 60
      const messageLimit = payload.messageLimit || 60
      const chatId = payload.chatId ? String(payload.chatId) : ''
      await refreshDialogs()
      const chats = store.chatList(limit)
      const unread = store.totalUnread()
      pushState()
      bus.broadcast({ t: 'chats', chats, unread })
      if (chatId) {
        wantedChats.add(chatId)
        await loadHistory(chatId, messageLimit)
        replyMessages(chatId, messageLimit, reply)
      } else {
        reply({ t: 'chats', chats, unread })
      }
      return
    }

    case 'messages': {
      if (!payload.chatId) throw new Error('messages: chatId required')
      const chatId = String(payload.chatId)
      const limit = payload.limit || 60
      wantedChats.add(chatId)
      if ((store.messages.get(chatId) || []).length < limit) await loadHistory(chatId, limit)
      replyMessages(chatId, limit, reply)
      return
    }

    case 'send': {
      if (!payload.chatId) throw new Error('send: chatId required')
      const chatId = String(payload.chatId)
      const text = String(payload.text || '')
      if (!text.trim()) throw new Error('send: empty message')
      if (connection !== 'open') throw new Error('send: not connected to Telegram')

      const sent = await tg.send(chatId, text)
      if (sent) {
        const message = ingest(chatId, sent, store.me?.name || 'You', true)
        if (message && (message.status || 0) < MSG_SENT) {
          message.status = MSG_SENT
          store.markDirty()
        }
        pushChats()
      }
      reply({ t: 'ack', id, ok: true, chatId })
      return
    }

    case 'read':
      if (!payload.chatId) throw new Error('read: chatId required')
      await markRead(String(payload.chatId))
      reply({ t: 'ack', id, ok: true, chatId: String(payload.chatId) })
      return

    case 'typing': {
      if (!payload.chatId || connection !== 'open') {
        reply({ t: 'ack', id, ok: false })
        return
      }
      await tg.typing(String(payload.chatId), payload.state !== 'paused')
      reply({ t: 'ack', id, ok: true })
      return
    }

    case 'press': {
      if (!payload.chatId) throw new Error('press: chatId required')
      if (!payload.id) throw new Error('press: message id required')
      if (connection !== 'open') throw new Error('press: not connected to Telegram')
      const chatId = String(payload.chatId)
      const row = Number(payload.row) || 0
      const col = Number(payload.col) || 0
      const result = await tg.pressButton(chatId, payload.id, row, col)
      if (result.sent) ingest(chatId, result.sent, store.me?.name || 'You', true)
      reply({ t: 'ack', id, ok: true, chatId, alert: result.alert, url: result.url })
      return
    }

    // Notification clicks land here: the daemon is already the fan-out point to
    // every bar panel, so it tells them which chat to open.
    case 'focus':
      if (!payload.chatId) throw new Error('focus: chatId required')
      bus.broadcast({ t: 'focus', chatId: String(payload.chatId) })
      reply({ t: 'ack', id, ok: true, chatId: String(payload.chatId) })
      return

    case 'api': {
      tg.saveApi({ apiId: payload.apiId, apiHash: payload.apiHash })
      needsApi = false
      lastError = ''
      pushState()
      reply({ t: 'ack', id, ok: true })
      return
    }

    case 'login': {
      const { already } = await startLogin('qr')
      reply({ t: 'ack', id, ok: true, ...(already ? { already: true } : {}) })
      return
    }

    case 'loginPhone': {
      const phone = String(payload.phone || '').replace(/[^\d+]/g, '')
      if (!phone) throw new Error('loginPhone: phone number required')
      const { already } = await startLogin('phone', phone)
      reply({ t: 'ack', id, ok: true, ...(already ? { already: true } : {}) })
      return
    }

    case 'code': {
      if (!pendingCode) throw new Error('code: no login waiting for a code')
      const box = pendingCode
      pendingCode = null
      setLastError('')
      box.resolve(String(payload.code || ''))
      reply({ t: 'ack', id, ok: true })
      return
    }

    case 'password': {
      if (!pendingPassword) throw new Error('password: no login waiting for a password')
      const box = pendingPassword
      pendingPassword = null
      setLastError('')
      box.resolve(String(payload.password ?? ''))
      reply({ t: 'ack', id, ok: true })
      return
    }

    case 'reconnect':
      stopPairing('reconnect')
      await tg.disconnect()
      connection = 'idle'
      connecting = false
      await connect()
      reply({ t: 'ack', id, ok: true })
      return

    case 'logout':
      stopPairing('logout')
      try {
        await tg.logout()
      } catch (err) {
        logger.debug({ err }, 'logout failed, clearing local state anyway')
      }
      store.clear()
      readOutboxMax.clear()
      wantedChats.clear()
      for (const chatId of [...muteExpiryTimers.keys()]) clearMuteExpiry(chatId)
      notifier.cancelAll()
      try {
        rmSync(mediaDir, { recursive: true, force: true })
      } catch {
        // Cache may already be gone.
      }
      ensureDirs()
      needsLogin = true
      connection = 'idle'
      connecting = false
      lastError = ''
      pushState()
      pushChats()
      reply({ t: 'ack', id, ok: true })
      return

    default:
      reply({ t: 'error', for: String(t || ''), id, message: `unknown command: ${t}` })
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let closePluginStateWatch = () => {}

function shutdown(signal) {
  if (stopping) return
  stopping = true
  logger.info({ signal }, 'shutting down')
  closePluginStateWatch()
  clearTimeout(pairingTimer)
  clearTimeout(floodTimer)
  for (const chatId of [...muteExpiryTimers.keys()]) clearMuteExpiry(chatId)
  notifier.cancelAll()
  store.persist()
  bus.close()
  tg.disconnect().catch(() => {})
  setTimeout(() => process.exit(0), 200).unref?.()
}

function stopWhenPluginIsDisabled() {
  if (stopping) return
  logger.info('plugin disabled; stopping the OmaGram service')
  const stopper = spawn(
    'systemctl',
    ['--user', 'disable', '--now', 'omarchy-omagram.service'],
    { detached: true, stdio: 'ignore' }
  )
  stopper.unref()
  shutdown('plugin-disabled')
}

function startPluginStateWatch() {
  closePluginStateWatch = observePluginState(stopWhenPluginIsDisabled)
}

// A killed daemon leaves versioned QR images behind. They are useless to the
// next run and each one can link the account, so clear them at startup.
function purgeStaleQrFiles() {
  try {
    for (const name of readdirSync(stateDir)) {
      if (/^qr\.\d+\.png$/.test(name)) removeFile(join(stateDir, name))
    }
  } catch (err) {
    logger.debug({ err }, 'startup: could not purge stale QR files')
  }
}

function claimPid() {
  let displaced = false
  try {
    const old = Number(readFileSync(pidFile, 'utf8'))
    if (old && old !== process.pid) {
      try {
        process.kill(old, 0)
        logger.warn({ pid: old }, 'startup: stopping leftover daemon that would fight this session')
        process.kill(old, 'SIGTERM')
        displaced = true
      } catch {
        // Already gone.
      }
    }
  } catch {
    // No pid file yet.
  }
  writeFileSync(pidFile, String(process.pid), { mode: 0o600 })
  return displaced
}

async function main() {
  ensureDirs()
  startPluginStateWatch()
  if (stopping) return
  if (claimPid()) await sleep(1500)
  purgeStaleQrFiles()
  clearQr()
  store.load()
  for (const chat of store.chats.values()) scheduleMuteExpiry(chat)

  media.getClient = () => tg.client
  media.resolvePeer = (chatId) => tg.peer(chatId)
  media.onReady = (chatId, message) => {
    store.markDirty()
    bus.broadcast({ t: 'messageMedia', chatId, id: message.id, imagePath: message.imagePath || '' })
  }

  wireTelegram()

  bus.snapshot = snapshot
  bus.onCommand = handleCommand
  try {
    await bus.listen()
  } catch (err) {
    if (err.code === 'EALREADYRUNNING') {
      logger.error(err.message)
      process.exit(3)
    }
    throw err
  }

  needsApi = !tg.loadApi()
  needsLogin = needsApi || !tg.hasSession()
  connection = 'idle'
  pushState()

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => shutdown(signal))
  process.on('uncaughtException', (err) => logger.error({ err }, 'uncaught exception'))
  process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'))

  // teleproto reconnects on its own. This only keeps the panel's badge honest
  // about whether the connection is currently up.
  const liveness = setInterval(() => {
    if (stopping || connecting) return
    if (connection === 'open' && !tg.connected) {
      connection = 'connecting'
      pushState()
      return
    }
    if (connection === 'connecting' && tg.connected && tg.me) {
      connection = 'open'
      pushState()
    }
  }, LIVENESS_INTERVAL_MS)
  liveness.unref?.()

  if (!needsLogin) await connect()
}

main().catch((err) => {
  logger.error({ err }, 'daemon failed to start')
  process.exit(1)
})
