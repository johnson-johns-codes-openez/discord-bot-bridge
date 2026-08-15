#!/usr/bin/env node
// Send a message (or threaded reply) through the bot.
// Usage: node reply.mjs <channelId> [msgId] "<text>"
//        - msgId "-" or omitted -> plain channel message
//        - msgId a message id  -> threaded reply to that message
import { Client, GatewayIntentBits } from 'discord.js'
import fs from 'node:fs'

const LOGINS = '/home/lemion/logins'
const [, , channelId, msgIdArg, ...rest] = process.argv
const text = rest.join(' ').trim()
if (!channelId || !text) {
  console.error('usage: reply.mjs <channelId> [msgId] "<text>"')
  process.exit(1)
}

const line = fs
  .readFileSync(LOGINS, 'utf8')
  .split('\n')
  .find((l) => l.startsWith('discord-bot-token:'))
const TOKEN = line ? line.split(/:\s*/)[1]?.trim() : null
if (!TOKEN) {
  console.error('NO discord-bot-token in ' + LOGINS)
  process.exit(2)
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
})

client.on('ready', async () => {
  try {
    const ch = await client.channels.fetch(channelId)
    ch.sendTyping().catch(() => {}) // typing indicator while the agent's reply is prepared
    if (msgIdArg && msgIdArg !== '-') {
      const m = await ch.messages.fetch(msgIdArg)
      await m.reply(text.slice(0, 2000))
    } else {
      await ch.send(text.slice(0, 2000))
    }
    console.log('sent to', channelId)
  } catch (e) {
    console.error('send err:', e.message)
    process.exitCode = 1
  }
  client.destroy()
})

client.login(TOKEN).catch((e) => {
  console.error('login err:', e.message)
  process.exit(1)
})
