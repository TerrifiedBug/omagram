import teleproto from 'teleproto'

const { utils } = teleproto

const IGNORABLE_ENTITIES = new Set([
  'UserEmpty',
  'ChatEmpty',
  'ChatForbidden',
  'ChannelForbidden'
])

function documentAttributes(message) {
  return message?.media?.document?.attributes || []
}

function documentAttribute(message, className) {
  return documentAttributes(message).find((attribute) => attribute?.className === className)
}

export function isService(message) {
  return message?.className === 'MessageService' || message?.className === 'MessageEmpty'
}

export function messageType(message) {
  const media = message?.media
  if (!media) return 'text'

  switch (media.className) {
    case 'MessageMediaPhoto':
      return 'photo'
    case 'MessageMediaDocument': {
      if (documentAttribute(message, 'DocumentAttributeSticker')) return 'sticker'
      if (documentAttribute(message, 'DocumentAttributeAnimated')) return 'gif'
      const audio = documentAttribute(message, 'DocumentAttributeAudio')
      if (media.voice || audio?.voice) return 'voice'
      if (media.round) return 'videoNote'
      if (media.video || documentAttribute(message, 'DocumentAttributeVideo')) return 'video'
      if (audio) return 'audio'
      return 'document'
    }
    case 'MessageMediaGeo':
    case 'MessageMediaGeoLive':
    case 'MessageMediaVenue':
      return 'location'
    case 'MessageMediaContact':
      return 'contact'
    case 'MessageMediaPoll':
      return 'poll'
    case 'MessageMediaDice':
      return 'dice'
    case 'MessageMediaStory':
      return 'story'
    case 'MessageMediaWebPage':
      return 'text'
    default:
      return 'unsupported'
  }
}

export function messageText(message) {
  if (typeof message?.message === 'string' && message.message.length > 0) return message.message

  switch (messageType(message)) {
    case 'text':
      return ''
    case 'photo':
      return '\uf03e Photo'
    case 'sticker': {
      const alt = documentAttribute(message, 'DocumentAttributeSticker')?.alt
      return alt ? `\uf118 Sticker ${alt}` : '\uf118 Sticker'
    }
    case 'gif':
      return '\uf03d GIF'
    case 'voice':
      return '\uf130 Voice message'
    case 'videoNote':
      return '\uf03d Video message'
    case 'video':
      return '\uf03d Video'
    case 'audio': {
      const audio = documentAttribute(message, 'DocumentAttributeAudio')
      return `\uf001 ${audio?.title || audio?.performer || 'Audio'}`
    }
    case 'document': {
      const filename = documentAttribute(message, 'DocumentAttributeFilename')?.fileName
      return `\uf15c ${filename || 'File'}`
    }
    case 'location':
      return '\uf041 Location'
    case 'contact':
      return '\uf007 Contact'
    case 'poll':
      return '\uf080 Poll'
    case 'dice':
      return '\uf522 Dice'
    case 'story':
      return '\uf03e Story'
    default:
      return 'Unsupported message'
  }
}

export function isPhotoMedia(message) {
  return message?.media?.className === 'MessageMediaPhoto'
}

// A bot's keyboard, flattened for the panel. Callback payloads stay in the
// daemon: the panel presses a button by position, so binary `data` never has to
// cross the wire or be trusted coming back.
//
// teleproto splits a button into the button (text, style) and its `type`, so an
// inline button's behaviour lives in `button.type.className`.
function buttonOf(button) {
  const text = String(button?.text || '')
  const type = button?.type
  switch (type?.className) {
    case 'InlineButtonTypeCallback':
    case 'InlineButtonTypeGame':
      return { text, kind: 'callback', url: '' }
    case 'InlineButtonTypeUrl':
    case 'InlineButtonTypeUrlAuth':
    case 'InlineButtonTypeWebView':
    case 'ButtonTypeSimpleWebView':
      return { text, kind: 'url', url: String(type.url || '') }
    case 'InlineButtonTypeCopy':
      return { text, kind: 'copy', url: String(type.copyText || '') }
    case 'ButtonTypeDefault':
      // Plain reply-keyboard key: pressing it sends its label as a message.
      return { text, kind: 'text', url: '' }
    default:
      return { text, kind: 'unsupported', url: '' }
  }
}

export function messageButtons(message) {
  const markup = message?.replyMarkup
  if (markup?.className !== 'ReplyInlineMarkup' && markup?.className !== 'ReplyKeyboardMarkup') return []
  const rows = []
  for (const row of markup.rows || []) {
    const buttons = (row?.buttons || []).map(buttonOf).filter((button) => button.text)
    if (buttons.length) rows.push(buttons)
  }
  return rows
}

export function displayName(entity) {
  if (!entity) return ''
  if (entity.className === 'User') {
    const name = [entity.firstName, entity.lastName].filter(Boolean).join(' ')
    if (name) return name
    if (entity.username) return entity.username
    return entity.deleted ? 'Deleted account' : ''
  }
  if (entity.className === 'Chat' || entity.className === 'Channel') return entity.title || ''
  return ''
}

export function chatKind(entity) {
  if (entity?.className === 'User') return 'user'
  if (entity?.className === 'Chat') return 'group'
  if (entity?.className === 'Channel') return entity.megagroup ? 'group' : 'channel'
  return ''
}

export function isIgnorableEntity(entity) {
  return IGNORABLE_ENTITIES.has(entity?.className)
}

export function chatIdOf(peer) {
  return utils.getPeerId(peer).toString()
}
