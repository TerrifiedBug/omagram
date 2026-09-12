import assert from 'node:assert/strict'
import test from 'node:test'

import { joinChatId, splitChatId } from '../lib/telegram.js'

test('splits a forum topic chat id from a plain one', () => {
  assert.deepEqual(splitChatId('93372553'), { base: '93372553', topicId: 0 })
  assert.deepEqual(splitChatId('-1004490104934'), { base: '-1004490104934', topicId: 0 })
  assert.deepEqual(splitChatId('-1004490104934#2'), { base: '-1004490104934', topicId: 2 })
})

test('treats a malformed topic suffix as the whole chat', () => {
  // A trailing or unparseable suffix must not silently address topic 0 of a
  // different peer, so the base keeps everything before the separator.
  assert.deepEqual(splitChatId('-1004490104934#'), { base: '-1004490104934', topicId: 0 })
  assert.deepEqual(splitChatId('-1004490104934#abc'), { base: '-1004490104934', topicId: 0 })
})

test('rebuilds a chat id only when there is a topic', () => {
  assert.equal(joinChatId('-1004490104934', 2), '-1004490104934#2')
  assert.equal(joinChatId('93372553', 0), '93372553')
})
