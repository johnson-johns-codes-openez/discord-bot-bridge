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
import { Client, GatewayIntentBits, Partials, SlashCommandBuilder } from 'discord.js'
import fs from 'node:fs'
import http from 'node:http'
import { execSync, spawn } from 'node:child_process'

const LOGINS = '/home/lemion/logins'
const INBOX = '/home/lemion/discord-bot/inbox.jsonl'
const AGENT_REQS = '/home/lemion/discord-bot/agent-requests.jsonl'
const BRIEFING = '/home/lemion/discord-bot/briefing.md'
const BRAIN_URL = 'https://discord-brain.johnson-johns-codes-openez.workers.dev/chat'
const PORT = Number(process.env.BRIDGE_PORT || 8757)
const OWNER_ID = '960791454379298817' // lemion._. - only they may control the bot
const AGENT_LOG = '/home/lemion/opencode-agent.log'
const RESUME_PROMPT = fs.readFileSync('/home/lemion/discord-bot/resume-prompt.txt', 'utf8').trim()

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

// Download attached files (text/csv/json) so John actually receives user data.
// Discord CDN URLs for private channels require the bot token as auth.
async function captureAttachments(attachments) {
  const out = []
  if (!attachments || !attachments.size) return out
  for (const a of attachments.values()) {
    const rec = { name: a.name, contentType: a.contentType || null, size: a.size }
    try {
      const r = await fetch(a.url, { headers: { Authorization: 'Bot ' + TOKEN } })
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer())
        const texty = /(csv|text|json|tsv|log|md|txt|html|xml)/i.test(rec.contentType || '')
        if (texty && buf.length <= 200 * 1024) {
          rec.text = buf.toString('utf8').slice(0, 200000)
        } else {
          rec.saved = `/tmp/opencode/attachments/${Date.now()}-${a.name.replace(/[^\w.-]/g, '_')}`
          fs.mkdirSync('/tmp/opencode/attachments', { recursive: true })
          fs.writeFileSync(rec.saved, buf)
        }
      } else {
        rec.err = 'fetch ' + r.status
      }
    } catch (e) {
      rec.err = String(e.message || e)
    }
    out.push(rec)
  }
  return out
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
// Retries transient edge 404/5xx (workers.dev deploy propagation) with backoff.
async function askBrain(clean) {
  let lastErr = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
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
      if (res.status === 404 || res.status >= 500) {
        lastErr = new Error('brain http ' + res.status)
        if (attempt < 3) await new Promise((r) => setTimeout(r, 4000 * attempt))
        continue
      }
      if (!res.ok) throw new Error('brain http ' + res.status)
      return res.json()
    } catch (e) {
      lastErr = e
      if (attempt < 3) await new Promise((r) => setTimeout(r, 4000 * attempt))
    }
  }
  throw lastErr || new Error('brain unreachable')
}

client.on('ready', () => {
  log(`logged in as ${client.user.tag} (id ${client.user.id})`)
  ping(`[discord-bot] ${client.user.tag} is ONLINE - @John or DM to talk to the agent`)
  registerCommands().catch((e) => log('register commands err: ' + e.message))
  scheduleWake()
})

// ---- One-shot 9AM local wake-up message (owner asked through the bot) ----
const WAKE_CHANNEL = '1538191225495097447' // owner DM
const WAKE_USER = '<@960791454379298817>'
const WAKE_HOUR = 9
function scheduleWake() {
  const now = new Date()
  const next = new Date(now)
  next.setHours(WAKE_HOUR, 0, 0, 0)
  if (next <= now) next.setDate(next.getDate() + 1)
  const ms = next - now
  log(`[wake] one-shot wake-up scheduled for ${next.toString()} (in ~${Math.round(ms / 60000)} min)`)
  setTimeout(async () => {
    try {
      const ch = await client.channels.fetch(WAKE_CHANNEL)
      await ch.send(
        `${WAKE_USER} ☀️ Rise and shine! 9AM local — the bounties aren't going to merge themselves. Coffee first, then John's on the grind.`
      )
      log('[wake] wake-up message sent')
    } catch (e) {
      log('[wake] send failed: ' + e.message)
    }
    // One-shot only; no re-arm. A new scheduleWake() call (bot restart) re-arms it.
  }, ms)
}

// ---- Slash commands: /john status | /john restart (owner-gated) ----
async function registerCommands() {
  const app = client.application
  const existing = await app.commands.fetch()
  const want = {
    john: new SlashCommandBuilder()
      .setName('john')
      .setDescription("John's status / restart (owner only)")
      .addSubcommand((s) => s.setName('status').setDescription('Check whether John (the agent) is alive and how the rig is doing'))
      .addSubcommand((s) => s.setName('restart').setDescription('Start John again if the agent died')),
  }
  for (const [name, builder] of Object.entries(want)) {
    const cmd = builder.toJSON()
    const found = existing.find((c) => c.name === name)
    if (found) {
      if (JSON.stringify(found.options) !== JSON.stringify(cmd.options)) {
        await app.commands.edit(found.id, { options: cmd.options })
        log(`updated slash command /${name}`)
      }
    } else {
      await app.commands.create(cmd)
      log(`registered slash command /${name}`)
    }
  }
}

function sh(cmd, fallback = 'n/a') {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 8000 }).trim() || fallback
  } catch {
    return fallback
  }
}

function agentPid() {
  const out = sh(`pgrep -x opencode || true`)
  const pids = out.split('\n').filter((p) => /^\d+$/.test(p.trim()))
  return pids.length ? pids[0] : null
}

async function statusReport() {
  const lines = []
  const pid = agentPid()
  lines.push(pid ? `🧠 John: ALIVE (pid ${pid})` : '🧠 John: DEAD - use /john restart to bring him back')
  const bridge = sh(`curl -s -m 5 http://127.0.0.1:8757/health`)
  lines.push(`🔌 Bridge bot: ${bridge === 'ok' ? 'ok' : 'DOWN (' + bridge + ')'}`)
  const brain = sh(`curl -s -m 8 https://discord-brain.johnson-johns-codes-openez.workers.dev/health`)
  lines.push(`🧠 Brain worker: ${brain.includes('"ok":true') ? 'ok' : 'down (' + brain.slice(0, 60) + ')'}`)
  const hg = sh(`sudo -n docker ps --filter name=^honeygain$ --format {{.Status}} 2>/dev/null`)
  lines.push(`🍯 Honeygain: ${hg.includes('Up') ? hg : 'DOWN (' + hg + ')'}`)
  const timers = sh(`systemctl --user list-timers --no-pager | grep -E "lb-real-watch|sphinx-watch|agent-feed-watch|bounty-watcher" | awk '{for(i=1;i<=NF;i++){if($i ~ /^[0-9][0-9]:[0-9][0-9]:[0-9][0-9]$/){if(!f){f=$i}; l=$i}}; print f, l, $(NF-1)}'`)
  for (const line of timers.split('\n')) {
    const [nextT, lastT, unit] = line.trim().split(/\s+/)
    if (unit) lines.push(`⏱ ${unit.replace('.timer', '')}: last ${lastT}, next ${nextT}`)
  }
  const jd = sh(`pgrep -f jumble-pr-watch.mjs || true`).split('\n').filter((p) => /^\d+$/.test(p.trim()))
  lines.push(`🔎 jumble watch: ${jd.length ? 'running' : 'DOWN'}`)
  const inbox = fs.readFileSync(INBOX, 'utf8').split('\n').filter(Boolean).length
  const inboxMark = Number(fs.readFileSync('/home/lemion/discord-bot/.last-replied-line', 'utf8').trim() || 0)
  lines.push(`📨 unhandled messages: ${Math.max(0, inbox - inboxMark)}`)
  const reqs = fs.existsSync(AGENT_REQS) ? fs.readFileSync(AGENT_REQS, 'utf8').split('\n').filter(Boolean).length : 0
  const reqMark = Number(fs.readFileSync('/home/lemion/discord-bot/.agent-request-count', 'utf8').trim() || 0)
  lines.push(`⚙️ queued agent-requests: ${Math.max(0, reqs - reqMark)}`)
  let money = '?'
  try {
    const m = fs.readFileSync('/home/lemion/bounties/STATE.md', 'utf8').match(/Money[^\n]*\$[0-9.]+/)
    if (m) money = m[0].replace(/Money\s*/i, '')
  } catch {
    /* keep ? */
  }
  lines.push(`💰 ${money}`)
  const threads = sh(`for i in "stakwork/sphinx-swarm 727" "stakwork/sphinx-swarm 728" "CodyTseng/jumble 846"; do set -- $i; printf "%s#%s=%s " "$1" "$2" "$(gh api repos/$1/issues/$2 --jq .state 2>/dev/null)"; done`, '')
  lines.push(`🧵 threads: ${threads}`)
  return lines.join('\n')
}

function startAgent() {
  const logFd = fs.openSync(AGENT_LOG, 'a')
  const child = spawn('/usr/bin/opencode', ['run', RESUME_PROMPT], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  })
  child.unref()
  return child.pid
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'john') return
  if (interaction.user.id !== OWNER_ID) {
    await interaction.reply({ content: 'Nope — owner only 🤖', ephemeral: true })
    return
  }
  const sub = interaction.options.getSubcommand()
  await interaction.deferReply()
  if (sub === 'status') {
    const report = await statusReport()
    await interaction.editReply(report.slice(0, 1900))
    log('[/john status] served to ' + interaction.user.username)
  } else if (sub === 'restart') {
    const pid = agentPid()
    if (pid) {
      await interaction.editReply(`John is already alive (pid ${pid}) — nothing to do. Use /john status for the full picture.`)
    } else {
      const spawned = startAgent()
      await new Promise((r) => setTimeout(r, 8000))
      const now = agentPid()
      await interaction.editReply(
        now
          ? `John was dead — spawned a fresh run (spawn pid ${spawned}); agent now up (pid ${now}). He will read STATE.md and resume the loop.`
          : `Spawned opencode run (pid ${spawned}) but the process check doesn't see it yet — give it a minute, then /john status.`
      )
      log('[/john restart] agent respawned: ' + spawned)
    }
  }
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

  // Route to the brain worker (with a typing indicator so the sender knows
  // we're working on it).
  let typingTimer = null
  const startTyping = () => {
    try {
      msg.channel.sendTyping().catch(() => {})
      typingTimer = setInterval(() => {
        msg.channel.sendTyping().catch(() => {})
      }, 8000)
    } catch {
      /* typing is best-effort */
    }
  }
  const stopTyping = () => {
    if (typingTimer) {
      clearInterval(typingTimer)
      typingTimer = null
    }
  }
  startTyping()
  const atts = await captureAttachments(msg.attachments)
  const attNote = atts.length
    ? ' [files attached: ' + atts.map((a) => a.name + (a.text ? ` (${a.text.length} chars)` : ' (binary)')).join(', ') + ']'
    : ''
  let brain
  try {
    brain = await askBrain(clean + attNote)
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
    attachments: atts,
    brainReply: brain ? brain.reply : null,
    brainErr: brain ? null : 'brain unavailable',
  })
  log(`message from ${msg.author.username}: ${clean.slice(0, 60)}`)

  // Real action requested -> queue it for the agent + notify.
  // Heuristic backstop: scheduling/reminder/wake-up asks must reach John even
  // if the brain classifies them as chat.
  const WANT_AGENT = /wake|alarm|remind|schedule|timer|9 ?a\.?m/i
  if ((brain && brain.needs_agent) || WANT_AGENT.test(clean)) {
    append(AGENT_REQS, {
      ts: Date.now(),
      author: msg.author.username,
      authorId: msg.author.id,
      channelId: msg.channel.id,
      msgId: msg.id,
      task: brain && brain.agent_task ? brain.agent_task : 'scheduling/reminder request: ' + clean.slice(0, 120),
      content: clean,
      attachments: atts,
    })
    ping(`[agent-request] from ${msg.author.username}: ${(brain && brain.agent_task || clean).slice(0, 120)} - John must act`)
  }

  try {
    let replyText = brain && brain.reply ? String(brain.reply) : ''
    // Last line of defense: never post JSON-ish model output into the channel
    if (/^\s*[{[]/.test(replyText) || /"reply"\s*:/.test(replyText)) {
      replyText = ''
      log('sanitized JSON-like brain reply from ' + msg.author.username)
    }
    if (replyText) {
      await msg.reply(replyText.slice(0, 1900))
    } else {
      await msg.reply("⚠️ John's assistant is having a moment — I've flagged this for John to look at on his next poll.")
    }
  } catch (e) {
    log('brain-reply err: ' + e.message)
  } finally {
    stopTyping()
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
  if (req.method === 'POST' && req.url === '/file') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      try {
        const { channelId, path, caption } = JSON.parse(body)
        if (!channelId || !path) {
          res.statusCode = 400
          res.end('need channelId + path')
          return
        }
        if (!fs.existsSync(path)) {
          res.statusCode = 400
          res.end('file not found: ' + path)
          return
        }
        const ch = await client.channels.fetch(channelId)
        await ch.send({
          content: caption ? String(caption).slice(0, 1900) : undefined,
          files: [path],
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
