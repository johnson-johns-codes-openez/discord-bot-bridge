#!/usr/bin/env node
// Discord bridge bot "John".
// - Listens for DMs and @mentions. Trivial queries are auto-answered locally.
//   Everything else is routed to the "John's assistant" brain worker
//   (Workers AI). If the brain flags needs_agent, the request is appended to
//   agent-requests.jsonl and the webhook is pinged so the agent loop picks it
//   up on its next poll; the sender is told John will handle it.
// - Logs every message to inbox.jsonl.
// - Exposes a localhost-only HTTP API (127.0.0.1:8757): POST /msg {channelId, content}
// Tokens/secrets are read at runtime from /home/lemion/logins. Never committed.
import { Client, GatewayIntentBits, Partials } from 'discord.js'
import fs from 'node:fs'
import http from 'node:http'
import { execSync } from 'node:child_process'

const LOGINS = '/home/lemion/logins'
const INBOX = '/home/lemion/discord-bot/inbox.jsonl'
const AGENT_REQS = '/home/lemion/discord-bot/agent-requests.jsonl'
const BRIEFING = '/home/lemion/discord-bot/briefing.md'
const BRAIN_URL = 'https://discord-brain.johnson-johns-codes-openez.workers.dev/chat'
const PORT = Number(process.env.BRIDGE_PORT || 8757)

function readKey(key) {
  const line = fs
    .readFileSync(LOGINS, 'utf8')
    .split('\n')
    .find((l) => l.startsWith(key))
  return line ? line.split(/:\s*/)[1]?.trim() : null
}

const TOKEN = readKey('discord-bot-token:')
if (!TOKEN) {
  console.error('[discord-bot] NO discord-bot-token found in ' + LOGINS)
  process.exit(2)
}
const BRAIN_SECRET = readKey('brain-secret:')
if (!BRAIN_SECRET) {
  console.error('[discord-bot] NO brain-secret found in ' + LOGINS)
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

function append(file, entry) {
  fs.appendFileSync(file, JSON.stringify(entry) + '\n')
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

function readBriefing() {
  try {
    return fs.readFileSync(BRIEFING, 'utf8').slice(0, 4000)
  } catch {
    return ''
  }
}

// Instant auto-answer for trivial queries (covers latency while the agent is
// mid-cycle). Anything else goes to the brain worker.
function quickAnswer(content) {
  const c = content.toLowerCase()
  if (/^(hi|hello|hey|yo|sup|oi)\b/.test(c)) {
    return "Hey! I'm John's assistant (running for Johnson John Codes Openez). Mention me or DM me anything — full replies come as threaded replies."
  }
  if (/^(ping|pong)$/.test(c)) return 'pong 🏓'
  if (/^(help|commands|who are you|what are you|what can you do)$/.test(c)) {
    return 'I answer questions about the experiment and pass real action requests to John. Ask me about status, bounties, or the run — or ask me to have John do something, and he will on his next poll.'
  }
  return null
}

// Call the brain worker. Returns { reply, needs_agent, agent_task }.
async function askBrain(clean) {
  const res = await fetch(BRAIN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + BRAIN_SECRET,
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: clean }],
      briefing: readBriefing(),
    }),
    signal: AbortSignal.timeout(60000),
  })
  if (!res.ok) throw new Error('brain http ' + res.status)
  return res.json()
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

  // Route to the brain worker.
  let brain
  try {
    brain = await askBrain(clean)
  } catch (e) {
    log('brain err: ' + e.message)
    brain = null
  }

  append(INBOX, {
    ts: Date.now(),
    author: msg.author.username,
    authorId: msg.author.id,
    channelId: msg.channel.id,
    msgId: msg.id,
    guildId: msg.guild?.id || null,
    isDM,
    content: clean,
    brainReply: brain ? brain.reply : null,
    brainErr: brain ? null : 'brain unavailable',
  })
  log(`message from ${msg.author.username}: ${clean.slice(0, 60)}`)

  if (brain && brain.needs_agent) {
    // Real action requested -> queue it for the agent + notify.
    append(AGENT_REQS, {
      ts: Date.now(),
      author: msg.author.username,
      authorId: msg.author.id,
      channelId: msg.channel.id,
      msgId: msg.id,
      task: brain.agent_task || clean.slice(0, 200),
      content: clean,
    })
    ping(`[agent-request] from ${msg.author.username}: ${(brain.agent_task || clean).slice(0, 120)} - John must act`)
  }

  try {
    if (brain && brain.reply) {
      await msg.reply(String(brain.reply).slice(0, 1900))
    } else {
      await msg.reply("⚠️ John's assistant is having a moment — I've flagged this for John to look at on his next poll.")
    }
  } catch (e) {
    log('brain-reply err: ' + e.message)
  }
})

// localhost API for other agents (VM-local only)
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.end('ok')
    return
  }
  if (req.method === 'POST' && req.url === '/img') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      try {
        const { channelId, image, caption } = JSON.parse(body)
        if (!channelId || !image) {
          res.statusCode = 400
          res.end('need channelId + image path')
          return
        }
        if (!fs.existsSync(image)) {
          res.statusCode = 400
          res.end('image not found: ' + image)
          return
        }
        const ch = await client.channels.fetch(channelId)
        await ch.send({
          content: caption ? String(caption).slice(0, 1900) : undefined,
          files: [image],
        })
        res.end('sent')
      } catch (e) {
        res.statusCode = 500
        res.end(String(e.message))
      }
    })
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
