import assert from 'node:assert/strict'
import test from 'node:test'

import { isService, messageButtons, messageText, messageType } from '../lib/message.js'

test('describes a photo', () => {
  const message = { className: 'Message', message: '', media: { className: 'MessageMediaPhoto' } }
  assert.equal(messageType(message), 'photo')
  assert.equal(messageText(message), '\uf03e Photo')
})

test('describes a sticker with its emoji', () => {
  const message = {
    className: 'Message',
    message: '',
    media: {
      className: 'MessageMediaDocument',
      document: { attributes: [{ className: 'DocumentAttributeSticker', alt: '🐛' }] }
    }
  }
  assert.equal(messageType(message), 'sticker')
  assert.equal(messageText(message), '\uf118 Sticker 🐛')
})

test('describes a voice message', () => {
  const message = {
    className: 'Message',
    message: '',
    media: { className: 'MessageMediaDocument', voice: true, document: { attributes: [] } }
  }
  assert.equal(messageType(message), 'voice')
  assert.equal(messageText(message), '\uf130 Voice message')
})

test('describes a document with its filename', () => {
  const message = {
    className: 'Message',
    message: '',
    media: {
      className: 'MessageMediaDocument',
      document: { attributes: [{ className: 'DocumentAttributeFilename', fileName: 'notes.pdf' }] }
    }
  }
  assert.equal(messageType(message), 'document')
  assert.equal(messageText(message), '\uf15c notes.pdf')
})

test('uses a media caption instead of its placeholder', () => {
  const message = {
    className: 'Message',
    message: 'Sunset from the hill',
    media: { className: 'MessageMediaPhoto' }
  }
  assert.equal(messageType(message), 'photo')
  assert.equal(messageText(message), 'Sunset from the hill')
})

test('recognizes service messages', () => {
  assert.equal(isService({ className: 'MessageService' }), true)
})

test('maps a bot keyboard to actionable button rows', () => {
  const message = {
    className: 'Message',
    message: 'Choose a bot',
    replyMarkup: {
      className: 'ReplyInlineMarkup',
      rows: [
        {
          buttons: [
            { className: 'KeyboardInlineButton', text: '@a_bot', type: { className: 'InlineButtonTypeCallback', data: Buffer.from('x') } },
            { className: 'KeyboardInlineButton', text: 'Docs', type: { className: 'InlineButtonTypeUrl', url: 'https://core.telegram.org' } }
          ]
        },
        {
          buttons: [
            { className: 'KeyboardInlineButton', text: 'Pay', type: { className: 'InlineButtonTypeBuy' } },
            { className: 'KeyboardInlineButton', text: '', type: { className: 'InlineButtonTypeCallback' } }
          ]
        }
      ]
    }
  }

  assert.deepEqual(messageButtons(message), [
    [
      { text: '@a_bot', kind: 'callback', url: '' },
      { text: 'Docs', kind: 'url', url: 'https://core.telegram.org' }
    ],
    [{ text: 'Pay', kind: 'unsupported', url: '' }]
  ])
})

test('reports no buttons for an ordinary message', () => {
  assert.deepEqual(messageButtons({ className: 'Message', message: 'hi' }), [])
  assert.deepEqual(messageButtons({ className: 'Message', replyMarkup: { className: 'ReplyKeyboardHide' } }), [])
})
