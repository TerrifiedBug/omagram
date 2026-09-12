const HAS_OWN = (value, key) => Object.prototype.hasOwnProperty.call(value, key)

export function isChatMuted(chat, nowMs = Date.now()) {
  if (!chat) return false
  return chat.muteEndTime !== null && chat.muteEndTime * 1000 > nowMs
}

export function shouldNotifyChat(chat, nowMs = Date.now()) {
  return !!chat && chat.archived !== true && !isChatMuted(chat, nowMs)
}

export function muteExpiryDelayMs(chat, nowMs = Date.now()) {
  if (!isChatMuted(chat, nowMs)) return null
  return Math.max(0, chat.muteEndTime * 1000 - nowMs)
}

export function applyChatNotificationPreferences(chat, update, nowMs = Date.now()) {
  let changed = false

  if (update.archived !== undefined) {
    const archived = update.archived === true
    if (chat.archived !== archived) changed = true
    chat.archived = archived
  }

  if (HAS_OWN(update, 'muteEndTime')) {
    const muteEndTime = update.muteEndTime
    if (!HAS_OWN(chat, 'muteEndTime') || chat.muteEndTime !== muteEndTime) changed = true
    chat.muteEndTime = muteEndTime

    const muted = isChatMuted(chat, nowMs)
    if (chat.muted !== muted) changed = true
    chat.muted = muted
  }

  return changed
}
