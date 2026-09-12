import { existsSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mediaDir } from './paths.js'
import { logger } from './logger.js'

const MAX_BYTES = 12 * 1024 * 1024
const MAX_PARALLEL = 2

function safePart(value, fallback) {
  const safe = String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
  return safe || fallback
}

export function mediaPathFor(id, ext = 'jpg') {
  return join(mediaDir, `${safePart(id, 'media')}.${safePart(ext, 'jpg')}`)
}

export function existingMediaPath(message) {
  if (!message?.id) return ''
  if (message.imagePath && existsSync(message.imagePath)) return message.imagePath
  const guessed = mediaPathFor(message.id, 'jpg')
  return existsSync(guessed) ? guessed : ''
}

export class MediaCache {
  constructor({ getClient = () => null, resolvePeer = async () => null, onReady = null } = {}) {
    this.queue = []
    this.active = 0
    this.inFlight = new Set()
    this.getClient = getClient
    this.resolvePeer = resolvePeer
    this.onReady = onReady
  }

  enqueue(chatId, message) {
    if (!chatId || !message?.id) return
    const id = String(message.id)
    const already = existingMediaPath(message)
    if (already) {
      if (message.imagePath !== already) {
        message.imagePath = already
        this.onReady?.(chatId, message)
      }
      return
    }

    const key = `${chatId}:${id}`
    if (this.inFlight.has(key)) return
    this.inFlight.add(key)
    this.queue.push({ chatId, id })
    this.pump()
  }

  pump() {
    while (this.active < MAX_PARALLEL && this.queue.length > 0) {
      const job = this.queue.shift()
      this.active += 1
      this.download(job).finally(() => {
        this.active -= 1
        this.inFlight.delete(`${job.chatId}:${job.id}`)
        this.pump()
      })
    }
  }

  async download({ chatId, id }) {
    const target = mediaPathFor(id, 'jpg')
    const tmp = `${target}.part`

    try {
      const client = this.getClient()
      if (!client) throw new Error('Telegram client unavailable')
      const peer = await this.resolvePeer(chatId)
      const messages = await client.getMessages(peer, { ids: [Number(id)] })
      const message = messages?.[0]
      if (!message) throw new Error('message not found')

      const sizes = message.photo?.sizes
      if (!Array.isArray(sizes) || sizes.length === 0) throw new Error('photo has no sizes')
      const preferred = sizes.findIndex((size) => size?.type === 'x')
      const thumb = preferred >= 0 ? preferred : sizes.length - 1
      const data = await client.downloadMedia(message, { thumb })
      if (!Buffer.isBuffer(data)) throw new Error('photo download returned no data')
      if (data.length > MAX_BYTES) throw new Error('photo exceeds 12 MiB limit')

      try { unlinkSync(tmp) } catch { /* no stale partial download */ }
      writeFileSync(tmp, data, { mode: 0o600 })
      renameSync(tmp, target)
      this.onReady?.(chatId, { id, imagePath: target })
    } catch (err) {
      try { unlinkSync(tmp) } catch { /* no partial download */ }
      logger.debug({ err: String(err?.message || err), chatId, id }, 'media: download failed')
    }
  }
}
