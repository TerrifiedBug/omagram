import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import teleproto from 'teleproto'

import { chatIdOf, chatKind, displayName, isIgnorableEntity, isService } from './message.js'
import { logger, tgLogger } from './logger.js'

const { Api, TelegramClient, Logger, errors, events, sessions } = teleproto

// Telegram's own client identifies itself in Settings -> Devices. Saying
// Omarchy there is the honest answer and makes the session easy to revoke.
const DEVICE_MODEL = 'Omarchy'
const APP_VERSION = '0.1.0'
const SYSTEM_VERSION = 'Linux'

const DIALOG_LIMIT = 300

// A 32-hex api_hash and a positive integer api_id are the only shapes
// my.telegram.org ever hands out. Anything else is a paste accident, and
// finding out at connect time costs a round trip and a confusing error.
const API_HASH_RE = /^[0-9a-f]{32}$/i

function asNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * Everything that touches teleproto lives here, so `index.js` stays a
 * translator between the wire protocol and this class.
 *
 * Events: `connecting`, `open`, `unauthorized`, `revoked`, `flood`,
 * `passwordRejected`, `codeRejected`, `error`, `message`, `readInbox`,
 * `readOutbox`, `notify`, `pinned`, `folder`.
 */
export class Telegram extends EventEmitter {
  constructor({ sessionFile, apiFile }) {
    super()
    this.sessionFile = sessionFile
    this.apiFile = apiFile
    this.client = null
    this.me = null
    this.peers = new Map()
    this.handlersBound = false
  }

  loadApi() {
    try {
      const raw = JSON.parse(readFileSync(this.apiFile, 'utf8'))
      const apiId = Number(raw?.apiId)
      const apiHash = String(raw?.apiHash || '')
      if (!Number.isInteger(apiId) || apiId <= 0 || !API_HASH_RE.test(apiHash)) return null
      return { apiId, apiHash }
    } catch {
      return null
    }
  }

  saveApi({ apiId, apiHash }) {
    const id = Number(apiId)
    if (!Number.isInteger(id) || id <= 0) throw new Error('api: invalid api_id')
    const hash = String(apiHash || '').trim()
    if (!API_HASH_RE.test(hash)) throw new Error('api: invalid api_hash')
    writeFileSync(this.apiFile, `${JSON.stringify({ apiId: id, apiHash: hash })}\n`, { mode: 0o600 })
    return { apiId: id, apiHash: hash }
  }

  hasSession() {
    try {
      return statSync(this.sessionFile).size > 0
    } catch {
      return false
    }
  }

  _readSession() {
    try {
      return readFileSync(this.sessionFile, 'utf8').trim()
    } catch {
      return ''
    }
  }

  saveSession() {
    if (!this.client) return
    writeFileSync(this.sessionFile, this.client.session.save(), { mode: 0o600 })
  }

  dropSession() {
    try {
      unlinkSync(this.sessionFile)
    } catch {
      // Never existed, or already gone.
    }
  }

  _build() {
    const api = this.loadApi()
    if (!api) throw new Error('login: api credentials required')
    this.api = api
    const session = new sessions.StringSession(this._readSession())
    this.client = new TelegramClient(session, api.apiId, api.apiHash, {
      connectionRetries: Infinity,
      retryDelay: 2000,
      // Short waits are slept through inside teleproto; long ones surface as
      // FloodWaitError so the daemon can say so in the panel.
      floodSleepThreshold: 60,
      autoReconnect: true,
      deviceModel: DEVICE_MODEL,
      appVersion: APP_VERSION,
      systemVersion: SYSTEM_VERSION,
      baseLogger: new Logger('error')
    })
    return this.client
  }

  /** Connect with whatever session is on disk. Emits `open` or `unauthorized`. */
  async connect() {
    this.emit('connecting')
    const client = this._build()
    await client.connect()
    if (!(await client.isUserAuthorized())) {
      this.emit('unauthorized')
      return false
    }
    await this._afterAuth()
    return true
  }

  /** Connect without a session, ready for a login flow. */
  async prepare() {
    this.emit('connecting')
    const client = this._build()
    await client.connect()
    return client
  }

  async _afterAuth() {
    this.saveSession()
    this.me = await this.client.getMe()
    this._bindHandlers()
    this.emit('open', this.me)
  }

  _onAuthError(err) {
    if (err?.errorMessage === 'PASSWORD_HASH_INVALID') {
      this.emit('passwordRejected')
      return false
    }
    if (err?.errorMessage === 'PHONE_CODE_INVALID' || err?.errorMessage === 'PHONE_CODE_EMPTY') {
      this.emit('codeRejected')
      return false
    }
    this.emit('error', err)
    return true
  }

  /**
   * QR login. teleproto refreshes the token every 30s and, when the account has
   * two-step verification, calls `onPassword` until it is accepted.
   */
  async loginQr({ onQr, onPassword, signal }) {
    const client = this.client || (await this.prepare())
    await client.signInUserWithQrCode(this.api, {
      qrCode: async ({ token }) => onQr(`tg://login?token=${token.toString('base64url')}`),
      password: (hint) => onPassword(hint || ''),
      onError: async (err) => this._onAuthError(err),
      abortSignal: signal
    })
    await this._afterAuth()
  }

  /** Phone + code login, driven from the CLI. */
  async loginPhone({ phone, onCode, onPassword }) {
    const client = this.client || (await this.prepare())
    await client.start({
      phoneNumber: phone,
      phoneCode: (viaApp) => onCode(!!viaApp),
      password: (hint) => onPassword(hint || ''),
      onError: async (err) => this._onAuthError(err)
    })
    await this._afterAuth()
  }

  async logout() {
    if (this.client) {
      try {
        await this.client.invoke(new Api.auth.LogOut())
      } catch (err) {
        logger.debug({ err }, 'logout: server call failed, clearing local state anyway')
      }
    }
    await this.disconnect()
    this.dropSession()
  }

  async disconnect() {
    const client = this.client
    this.client = null
    this.me = null
    this.peers.clear()
    this.handlersBound = false
    if (!client) return
    try {
      await client.destroy()
    } catch (err) {
      logger.debug({ err }, 'disconnect failed')
    }
  }

  get connected() {
    return !!this.client?.connected
  }

  /** Dialogs, flattened into the panel's Chat shape. */
  async dialogs() {
    const list = await this.client.getDialogs({ limit: DIALOG_LIMIT })
    const out = []
    for (const d of list) {
      if (!d?.id) continue
      if (d.entity && isIgnorableEntity(d.entity)) continue
      const chatId = d.id.toString()
      this.peers.set(chatId, d.inputEntity)
      const muteUntil = d.dialog?.notifySettings?.muteUntil
      out.push({
        chatId,
        name: d.title || d.name || '',
        kind: d.entity ? chatKind(d.entity) : (d.isUser ? 'user' : 'group'),
        isGroup: !!d.isGroup,
        unread: d.unreadCount || 0,
        muteUntil: typeof muteUntil === 'number' ? muteUntil : null,
        archived: !!d.archived,
        pinned: !!d.pinned,
        username: d.entity?.username || '',
        readOutboxMaxId: asNumber(d.dialog?.readOutboxMaxId),
        top: d.message && !isService(d.message) ? d.message : null,
        topSender: d.isGroup && d.message ? displayName(d.message.sender) : ''
      })
    }
    return out
  }

  /**
   * Marked bot-API ids round-trip through teleproto's entity cache. A miss
   * means the dialog list is stale, so refresh it once before giving up.
   */
  async peer(chatId) {
    const key = String(chatId)
    const cached = this.peers.get(key)
    if (cached) return cached
    try {
      const resolved = await this.client.getInputEntity(Number(key))
      this.peers.set(key, resolved)
      return resolved
    } catch (err) {
      logger.debug({ err, chatId: key }, 'peer: cache miss, refreshing dialogs')
    }
    await this.dialogs()
    const refreshed = this.peers.get(key)
    if (!refreshed) throw new Error('unknown chat')
    return refreshed
  }

  async history(chatId, limit) {
    const peer = await this.peer(chatId)
    const list = await this.client.getMessages(peer, { limit })
    return [...list].filter((m) => m && !isService(m)).reverse()
  }

  async send(chatId, text) {
    const peer = await this.peer(chatId)
    // No parseMode, so the text the user typed is the text that arrives.
    return this.client.sendMessage(peer, { message: text })
  }

  /**
   * Press a bot keyboard button by position. The callback payload is read off
   * the live message rather than taken from the caller, so the panel cannot be
   * tricked into submitting data of its own.
   *
   * Returns `{alert, url}`: `alert` is the bot's toast text, `url` a link the
   * caller should open instead.
   */
  async pressButton(chatId, msgId, row, col) {
    const peer = await this.peer(chatId)
    const [message] = await this.client.getMessages(peer, { ids: [Number(msgId)] })
    const button = message?.replyMarkup?.rows?.[row]?.buttons?.[col]
    const type = button?.type
    if (!type) throw new Error('press: no such button')

    switch (type.className) {
      case 'InlineButtonTypeUrl':
      case 'InlineButtonTypeUrlAuth':
      case 'InlineButtonTypeWebView':
      case 'ButtonTypeSimpleWebView':
        return { alert: '', url: String(type.url || '') }
      case 'InlineButtonTypeCopy':
        return { alert: '', url: '', copy: String(type.copyText || '') }
      case 'ButtonTypeDefault': {
        const sent = await this.client.sendMessage(peer, { message: String(button.text || '') })
        return { alert: '', url: '', sent }
      }
      case 'InlineButtonTypeCallback':
      case 'InlineButtonTypeGame':
        break
      default:
        throw new Error('press: unsupported button')
    }

    const answer = await this.client.invoke(new Api.messages.GetBotCallbackAnswer({
      peer,
      msgId: Number(msgId),
      data: type.data
    }))
    return { alert: String(answer?.message || ''), url: String(answer?.url || '') }
  }

  async markRead(chatId) {
    const peer = await this.peer(chatId)
    await this.client.markAsRead(peer)
  }

  async typing(chatId, composing) {
    try {
      const peer = await this.peer(chatId)
      await this.client.invoke(new Api.messages.SetTyping({
        peer,
        action: composing ? new Api.SendMessageTypingAction() : new Api.SendMessageCancelAction()
      }))
    } catch (err) {
      logger.debug({ err, chatId }, 'typing update failed')
    }
  }

  /** Turn a thrown teleproto error into the event the daemon reacts to. */
  classifyError(err) {
    if (err instanceof errors.FloodWaitError) {
      this.emit('flood', asNumber(err.seconds))
      return 'flood'
    }
    if (err instanceof errors.SessionRevokedError
      || err instanceof errors.AuthKeyUnregisteredError
      || err?.errorMessage === 'SESSION_REVOKED'
      || err?.errorMessage === 'AUTH_KEY_UNREGISTERED'
      || err?.errorMessage === 'USER_DEACTIVATED') {
      this.emit('revoked')
      return 'revoked'
    }
    return ''
  }

  _bindHandlers() {
    if (this.handlersBound || !this.client) return
    this.handlersBound = true
    const client = this.client

    const deliver = async (event, name) => {
      const raw = event?.message
      if (!raw || isService(raw)) return
      const chatId = event.chatId ? event.chatId.toString() : chatIdOf(raw.peerId)
      let senderName = ''
      if (!raw.out) {
        const sender = await raw.getSender().catch(() => null)
        senderName = displayName(sender)
      }
      const inputPeer = await raw.getInputChat().catch(() => null)
      if (inputPeer) this.peers.set(chatId, inputPeer)
      this.emit(name, { chatId, raw, senderName })
    }

    client.addEventHandler((event) => deliver(event, 'message'), new events.NewMessage({}))
    // A bot answering a callback usually edits its own message in place, so
    // without this the buttons the user just pressed would never change.
    client.addEventHandler((event) => deliver(event, 'edited'), new events.EditedMessage({}))

    client.addEventHandler((update) => this._onRaw(update), new events.Raw({
      types: [
        Api.UpdateReadHistoryInbox,
        Api.UpdateReadChannelInbox,
        Api.UpdateReadHistoryOutbox,
        Api.UpdateReadChannelOutbox,
        Api.UpdateNotifySettings,
        Api.UpdateDialogPinned,
        Api.UpdateFolderPeers
      ]
    }))

    tgLogger.debug('telegram: update handlers bound')
  }

  _onRaw(update) {
    const channelId = (id) => chatIdOf(new Api.PeerChannel({ channelId: id }))
    switch (update.className) {
      case 'UpdateReadHistoryInbox':
        this.emit('readInbox', { chatId: chatIdOf(update.peer), unread: asNumber(update.stillUnreadCount) })
        return
      case 'UpdateReadChannelInbox':
        this.emit('readInbox', { chatId: channelId(update.channelId), unread: asNumber(update.stillUnreadCount) })
        return
      case 'UpdateReadHistoryOutbox':
        this.emit('readOutbox', { chatId: chatIdOf(update.peer), maxId: asNumber(update.maxId) })
        return
      case 'UpdateReadChannelOutbox':
        this.emit('readOutbox', { chatId: channelId(update.channelId), maxId: asNumber(update.maxId) })
        return
      case 'UpdateNotifySettings': {
        if (update.peer?.className !== 'NotifyPeer') return
        const muteUntil = update.notifySettings?.muteUntil
        this.emit('notify', {
          chatId: chatIdOf(update.peer.peer),
          muteUntil: typeof muteUntil === 'number' ? muteUntil : null
        })
        return
      }
      case 'UpdateDialogPinned':
        if (update.peer?.className !== 'DialogPeer') return
        this.emit('pinned', { chatId: chatIdOf(update.peer.peer), pinned: !!update.pinned })
        return
      case 'UpdateFolderPeers':
        for (const fp of update.folderPeers || []) {
          if (fp.peer?.className !== 'DialogPeer') continue
          this.emit('folder', { chatId: chatIdOf(fp.peer.peer), archived: asNumber(fp.folderId) === 1 })
        }
        return
      default:
    }
  }
}
