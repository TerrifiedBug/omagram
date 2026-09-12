import assert from 'node:assert/strict'
import test from 'node:test'

import { Store } from '../lib/store.js'

test('unread total excludes muted and archived chats but includes expired mutes', () => {
  const store = new Store()
  const nowSeconds = Math.floor(Date.now() / 1000)

  store.setUnread('1001', 2)

  const muted = store.setUnread('1002', 4)
  muted.muteEndTime = nowSeconds + 60
  muted.muted = true

  const archived = store.setUnread('-1003', 8)
  archived.archived = true

  const expired = store.setUnread('-1004', 16)
  expired.muteEndTime = nowSeconds - 60
  expired.muted = true

  assert.equal(store.totalUnread(), 18)
})
