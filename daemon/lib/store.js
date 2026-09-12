import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { storeFile } from './paths.js'
import { logger } from './logger.js'
import { shouldNotifyChat } from './preferences.js'

const MAX_MESSAGES_PER_CHAT = 200
const MAX_CHATS = 300
const PERSIST_DEBOUNCE_MS = 2000

// In-memory chat and message state with a JSON snapshot on disk. The snapshot
// lets the panel render immediately while fresh dialogs and history load.
export class Store {
  constructor() {
    /** @type {Map<string, object>} */
    this.chats = new Map()
    /** @type {Map<string, object[]>} */
    this.messages = new Map()
    this.me = null
    this._persistTimer = null
    this._dirty = false
  }

  load() {
    let raw
    try {
      raw = readFileSync(storeFile, 'utf8')
    } catch (err) {
      if (err.code !== 'ENOENT') logger.warn({ err }, 'store: unreadable snapshot, starting empty')
      return
    }

    try {
      const data = JSON.parse(raw)
      if (data.version !== 1) {
        this.chats.clear()
        this.messages.clear()
        this.me = null
        this._dirty = true
        this.persist()
        logger.info({ version: data.version }, 'store: unsupported snapshot replaced')
        return
      }

      const chats = new Map()
      const messages = new Map()
      for (const chat of data.chats || []) {
        if (chat?.chatId) chats.set(chat.chatId, chat)
      }
      for (const [chatId, list] of Object.entries(data.messages || {})) {
        if (!Array.isArray(list)) continue
        const saved = list.slice(-MAX_MESSAGES_PER_CHAT)
        for (const message of saved) {
          if (message.imagePath && !existsSync(message.imagePath)) message.imagePath = ''
        }
        messages.set(chatId, saved)
      }

      this.chats = chats
      this.messages = messages
      this.me = data.me || null
      logger.info({ chats: this.chats.size }, 'store: snapshot loaded')
    } catch (err) {
      logger.warn({ err }, 'store: corrupt snapshot, starting empty')
    }
  }

  markDirty() {
    this._dirty = true
    if (this._persistTimer) return
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null
      this.persist()
    }, PERSIST_DEBOUNCE_MS)
    this._persistTimer.unref?.()
  }

  persist() {
    if (!this._dirty) return

    const chats = this.sortedChats().slice(0, MAX_CHATS)
    const messages = {}
    for (const chat of chats) {
      const list = this.messages.get(chat.chatId)
      if (list?.length) messages[chat.chatId] = list.slice(-MAX_MESSAGES_PER_CHAT)
    }
    const payload = {
      version: 1,
      me: this.me,
      chats,
      messages
    }
    const tmp = `${storeFile}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 })
      renameSync(tmp, storeFile)
      this._dirty = false
    } catch (err) {
      logger.warn({ err }, 'store: snapshot write failed')
    }
  }

  chat(chatId) {
    const key = String(chatId)
    let chat = this.chats.get(key)
    if (!chat) {
      chat = {
        chatId: key,
        name: '',
        kind: 'user',
        isGroup: false,
        unread: 0,
        muted: false,
        muteEndTime: null,
        archived: false,
        pinned: false,
        lastTs: 0,
        lastText: '',
        lastFromMe: false,
        lastSender: '',
        username: '',
        // Forum topic rows only: the group they belong to and the topic id.
        group: '',
        topicId: 0
      }
      this.chats.set(key, chat)
      this.markDirty()
    }
    return chat
  }

  upsertMessage(chatId, message) {
    const key = String(chatId)
    const list = this.messages.get(key) || []
    const existing = list.findIndex((item) => item.id === message.id)
    if (existing === -1) {
      list.push(message)
    } else {
      const previous = list[existing]
      list[existing] = {
        ...previous,
        ...message,
        status: Math.max(previous.status || 0, message.status || 0)
      }
    }

    list.sort((a, b) => {
      const timestampOrder = (a.ts || 0) - (b.ts || 0)
      if (timestampOrder !== 0) return timestampOrder
      return Number(a.id) - Number(b.id)
    })
    if (list.length > MAX_MESSAGES_PER_CHAT) list.splice(0, list.length - MAX_MESSAGES_PER_CHAT)

    this.messages.set(key, list)
    this.markDirty()
    return list
  }

  touchChat(chatId, message) {
    const chat = this.chat(chatId)
    if ((message.ts || 0) >= (chat.lastTs || 0)) {
      chat.lastTs = message.ts || 0
      chat.lastText = message.text
      chat.lastFromMe = !!message.fromMe
      chat.lastSender = message.senderName || ''
    }
    this.markDirty()
    return chat
  }

  setUnread(chatId, count) {
    const chat = this.chat(chatId)
    chat.unread = Math.max(0, Number(count) || 0)
    this.markDirty()
    return chat
  }

  bumpUnread(chatId) {
    const chat = this.chat(chatId)
    chat.unread = Math.max(0, chat.unread || 0) + 1
    this.markDirty()
    return chat
  }

  totalUnread() {
    let total = 0
    for (const chat of this.chats.values()) {
      if (shouldNotifyChat(chat)) total += Math.max(0, chat.unread || 0)
    }
    return total
  }

  sortedChats() {
    return [...this.chats.values()]
      .filter((chat) => chat.lastTs > 0 || chat.unread > 0)
      .sort((a, b) => {
        if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1
        return (b.lastTs || 0) - (a.lastTs || 0)
      })
  }

  chatList(limit = 40) {
    return this.sortedChats().slice(0, Math.max(1, limit))
  }

  messageList(chatId, limit = 60) {
    const list = this.messages.get(String(chatId)) || []
    return list.slice(-Math.max(1, limit))
  }

  findMessage(chatId, id) {
    if (!id) return null
    const list = this.messages.get(String(chatId))
    return list?.find((message) => message.id === id) || null
  }

  clear() {
    this.chats.clear()
    this.messages.clear()
    this.me = null
    this._dirty = true
    this.persist()
  }
}
