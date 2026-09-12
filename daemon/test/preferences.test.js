import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyChatNotificationPreferences,
  isChatMuted,
  muteExpiryDelayMs,
  shouldNotifyChat
} from '../lib/preferences.js'

const NOW_MS = 1_800_000_000_000
const NOW_SECONDS = NOW_MS / 1000

test('recognizes active and expired mute deadlines in seconds', () => {
  assert.equal(isChatMuted({ muteEndTime: NOW_SECONDS + 60 }, NOW_MS), true)
  assert.equal(isChatMuted({ muteEndTime: NOW_SECONDS - 60 }, NOW_MS), false)
  assert.equal(isChatMuted({ muteEndTime: null }, NOW_MS), false)
})

test('applies partial archive and mute updates without resetting absent fields', () => {
  const chat = { archived: true, muted: false, muteEndTime: null }

  assert.equal(
    applyChatNotificationPreferences(chat, { muteEndTime: NOW_SECONDS + 60 }, NOW_MS),
    true
  )
  assert.deepEqual(chat, {
    archived: true,
    muted: true,
    muteEndTime: NOW_SECONDS + 60
  })

  applyChatNotificationPreferences(chat, { archived: false }, NOW_MS)
  assert.equal(chat.archived, false)
  assert.equal(chat.muteEndTime, NOW_SECONDS + 60)

  applyChatNotificationPreferences(chat, { muteEndTime: null }, NOW_MS)
  assert.equal(chat.muted, false)
  assert.equal(chat.muteEndTime, null)
})

test('suppresses notifications for archived chats and active mutes', () => {
  assert.equal(shouldNotifyChat({ archived: true, muteEndTime: null }, NOW_MS), false)
  assert.equal(shouldNotifyChat({ archived: false, muteEndTime: NOW_SECONDS + 1 }, NOW_MS), false)
  assert.equal(shouldNotifyChat({ archived: false, muteEndTime: NOW_SECONDS - 1 }, NOW_MS), true)
})

test('reports the remaining delay only while a mute is active', () => {
  assert.equal(muteExpiryDelayMs({ muteEndTime: NOW_SECONDS + 60 }, NOW_MS), 60_000)
  assert.equal(muteExpiryDelayMs({ muteEndTime: NOW_SECONDS - 60 }, NOW_MS), null)
  assert.equal(muteExpiryDelayMs({ muteEndTime: null }, NOW_MS), null)
})
