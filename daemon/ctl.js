#!/usr/bin/env node
// Thin NDJSON client for the daemon socket. No dependencies, so it works before
// `npm install` has ever run in daemon/.

import net from 'node:net'
import { socketPath } from './lib/paths.js'

const [command, ...args] = process.argv.slice(2)

const USAGE = `Usage: omarchy-omagram-ctl <command> [args]

  status                    connection state, linked account, unread count
  chats [limit]             most recent chats as JSON
  refresh [chatId] [limit]  resync chats from Telegram, then dump the list
  messages <chatId> [limit] a chat's recent messages as JSON
  send <chatId> <text...>   send a text message
  read <chatId>             mark a chat read
  focus <chatId>            select that chat in every open bar panel
  login                     start QR login (stops after 5 minutes)
  loginPhone <phone>        start a phone + code login
  code                      one login code, read from stdin
  password                  2FA password, read from stdin
  api                       api_id then api_hash, one per line on stdin
  reconnect                 drop the connection and reconnect
  logout                    end this Telegram session and clear local state
  ping                      check the daemon is alive
`

if (!command || command === '-h' || command === '--help') {
  process.stdout.write(USAGE)
  process.exit(command ? 0 : 1)
}

function fail(message) {
  process.stderr.write(`omarchy-omagram-ctl: ${message}\n`)
  process.exit(1)
}

// Secrets never travel in argv, where any user on the box can read them out of
// /proc. They come in on stdin, one per line.
async function readStdinLines(count, what) {
  let text = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) {
    text += chunk
    if (text.split('\n').length > count) break
  }
  const lines = text.split('\n').slice(0, count)
  if (lines.length < count || lines.some((line) => line.length === 0)) {
    fail(`${command}: expected ${what} on stdin`)
  }
  return lines
}

async function buildRequest() {
  switch (command) {
    case 'status':
      return { t: 'hello' }
    case 'ping':
      return { t: 'ping' }
    case 'chats':
      return { t: 'chats', limit: Number(args[0]) || 40 }
    case 'refresh':
      return { t: 'refresh', chatId: args[0] || undefined, limit: Number(args[1]) || 40 }
    case 'messages':
      if (!args[0]) fail('messages: chatId required')
      return { t: 'messages', chatId: args[0], limit: Number(args[1]) || 60 }
    case 'send':
      if (args.length < 2) fail('send: chatId and text required')
      return { t: 'send', chatId: args[0], text: args.slice(1).join(' ') }
    case 'read':
      if (!args[0]) fail('read: chatId required')
      return { t: 'read', chatId: args[0] }
    case 'focus':
      if (!args[0]) fail('focus: chatId required')
      return { t: 'focus', chatId: args[0] }
    case 'login':
      return { t: 'login' }
    case 'loginPhone':
      if (!args[0]) fail('loginPhone: phone number required')
      return { t: 'loginPhone', phone: args[0] }
    case 'code': {
      const [code] = await readStdinLines(1, 'the login code')
      return { t: 'code', code }
    }
    case 'password': {
      const [password] = await readStdinLines(1, 'the 2FA password')
      return { t: 'password', password }
    }
    case 'api': {
      const [apiId, apiHash] = await readStdinLines(2, 'api_id then api_hash')
      return { t: 'api', apiId: Number(apiId), apiHash }
    }
    case 'reconnect':
      return { t: 'reconnect' }
    case 'logout':
      return { t: 'logout' }
    default:
      return fail(`unknown command: ${command}\n\n${USAGE}`)
  }
}

const request = await buildRequest()
const socket = net.connect(socketPath)
let buffer = ''
let settled = false

const timeout = setTimeout(() => {
  if (settled) return
  settled = true
  socket.destroy()
  fail('timed out waiting for the daemon')
}, 15000)

socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))

socket.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  let index = buffer.indexOf('\n')
  while (index !== -1) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    index = buffer.indexOf('\n')
    if (!line) continue

    let payload
    try {
      payload = JSON.parse(line)
    } catch {
      continue
    }

    // Every client gets a `state` push on connect. For `status` that *is* the
    // answer; for anything else it is noise to skip.
    if (payload.t === 'state' && command !== 'status') continue

    settled = true
    clearTimeout(timeout)
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    socket.end()
    process.exit(payload.t === 'error' || payload.ok === false ? 1 : 0)
  }
})

socket.on('error', (err) => {
  if (settled) return
  settled = true
  clearTimeout(timeout)
  if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
    fail('daemon is not running. Start it with: systemctl --user start omarchy-omagram')
  }
  fail(String(err.message || err))
})

socket.on('close', () => {
  if (settled) return
  settled = true
  clearTimeout(timeout)
  fail('daemon closed the connection without answering')
})
