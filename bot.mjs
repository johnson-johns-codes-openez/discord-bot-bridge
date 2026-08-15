#!/usr/bin/env node
// Discord bridge bot "John".
// - Listens for DMs and @mentions, writes them to inbox.jsonl, pings the
//   webhook so the agent loop notices, and acks the sender instantly.
// - Exposes a localhost-only HTTP API (127.0.0.1:8757) so other AI agents
//   can post through the bot:  POST /msg {channelId, content}
// The bot token is read at runtime from /home/lemion/logins (discord-bot-token
// line). It is never committed or logged.
import { Client, GatewayIntentBits, Partials } from 'discord.js'
import fs from 'node:fs'
import http from 'node:http'
import { execSync } from 'node:child_process'

const LOGINS = '/home/lemion/logins'
const INBOX = '/home/lemion/discord-bot/inbox.jsonl'
const PORT = Number(process.env.BRIDGE_PORT || 8757)

function readToken() {
  const line = fs
    .readFileSync(LOGINS, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('discord-bot-token:'))
  return line ? line.split(/:\s*/)[1]?.trim() : null
}

const TOKEN = readToken()
if (!TOKEN) {
  console.error('[discord-bot] NO discord-bot-token found in ' + LOGINS + ' - add: discord-bot-token: <token>')
  process.exit(2)
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
})

function log(m) {
  console.log(new Date().toISOString(), m)
}

function toInbox(entry) {
  fs.appendFileSync(INBOX, JSON.stringify(entry) + '\n')
}

function ping(msg) {
  try {
    execSync(`node /home/lemion/bounties/webhook.mjs ${JSON.stringify(msg)}`, {
      timeout: 20000,
      stdio: 'ignore',
    })
  } catch {
    /* webhook is best-effort */
  }
}

// Instant auto-answer for trivial queries (covers latency while the agent is
// mid-cycle). Anything else goes to the agent loop via the inbox.
function quickAnswer(content) {
  const c = content.toLowerCase()
  if (/^(hi|hello|hey|yo|sup|oi)\b/.test(c)) {
    return "Hey! I'm the agent behind this bot (Johnson John Codes Openez). Mention me or DM me anything — full replies come as threaded replies."
  }
  if (/^(ping|pong)$/.test(c)) return 'pong 🏓'
  if (/(how'?s it going|how are you|what'?s up|status|how'?s the run|money|earnings|sat)/.test(c)) {
    let lb = '?', sp = '?', money = '$0.00'
    try { lb = (JSON.parse(fs.readFileSync('/home/lemion/bounties/lb-real-seen.json', 'utf8')).issues || []).length } catch {}
    try { sp = (JSON.parse(fs.readFileSync('/home/lemion/bounties/sphinx-seen.json', 'utf8')).bounties || []).length } catch {}
    return `Live status: watching ${lb} Lightning Bounties + ${sp} Sphinx bounties, no new OPEN work right now. Earnings: ${money} (all plays deployed, waiting on maintainers). Ask me for details!`
  }
  return null
}

client.on('ready', () => {
  log(`logged in as ${client.user.tag} (id ${client.user.id})`)
  ping(`[discord-bot] ${client.user.tag} is ONLINE - @John or DM to talk to the agent`)
})

client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return
  const isDM = msg.channel.type === 1 // DM channel
  const mentionsMe =
    msg.mentions.has(client.user.id) ||
    (msg.content || '').includes(`<@${client.user.id}>`) ||
    (msg.content || '').includes(`<@!${client.user.id}>`)
  if (!isDM && !mentionsMe) return

  const clean = (msg.content || '').replace(/<@!?(\d+)>/g, '').trim()
  const auto = quickAnswer(clean)
  if (auto) {
    try {
      await msg.reply(auto)
      log(`auto-answered ${msg.author.username}: ${clean.slice(0, 40)}`)
    } catch (e) {
      log('auto-reply err: ' + e.message)
    }
    return
  }
  toInbox({
    ts: Date.now(),
    author: msg.author.username,
    authorId: msg.author.id,
    channelId: msg.channel.id,
    msgId: msg.id,
    guildId: msg.guild?.id || null,
    isDM,
    content: clean,
  })
  log(`message from ${msg.author.username}: ${clean.slice(0, 60)}`)
  ping(`[discord-bot] msg from ${msg.author.username}: "${clean.slice(0, 80)}" - agent will reply`)
  try {
    await msg.reply('Got it! The agent is on it - reply coming in a moment.')
  } catch {
    /* ack is best-effort */
  }
})

// localhost API for other agents (VM-local only)
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.end('ok')
    return
  }
  if (req.method === 'POST' && req.url === '/msg') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      try {
        const { channelId, content } = JSON.parse(body)
        if (!channelId || !content) {
          res.statusCode = 400
          res.end('need channelId + content')
          return
        }
        const ch = await client.channels.fetch(channelId)
        await ch.send(String(content).slice(0, 2000))
        res.end('sent')
      } catch (e) {
        res.statusCode = 500
        res.end(String(e.message))
      }
    })
    return
  }
  res.statusCode = 404
  res.end('not found')
})
server.listen(PORT, '127.0.0.1', () => log(`agent API on http://127.0.0.1:${PORT}`))

client.login(TOKEN).catch((e) => {
  console.error('[discord-bot] login failed:', e.message)
  process.exit(1)
})
