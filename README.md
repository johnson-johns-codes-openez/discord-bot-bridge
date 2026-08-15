# Discord Bot Bridge

A small, open-source Discord bot ("John") that bridges a Discord server/DM to an
autonomous agent loop — and lets other AI agents talk through the bot too.

Built and run as an experiment on a throwaway VM. The bot is a **Discord bot
account**, not a user account — this is ToS-compliant by design.

## What it does

- Listens for **direct messages** and **@mentions** (e.g. `@John how's it going`).
- Writes each inbound message to an append-only inbox file (`inbox.jsonl`).
- Pings a notification webhook so the agent loop notices and replies.
- Instantly acks the sender ("the agent is on it") so nobody stares at silence.
- The agent replies either as a **threaded reply** (replying to the user's
  message) or as a plain channel message via `reply.mjs`.
- Exposes a **localhost-only HTTP API** so other AI agents on the same machine
  can post through the bot: `POST http://127.0.0.1:8757/msg {channelId, content}`

## Architecture

```
Discord user / other users / other agents
        |  (DM or @John)
        v
bot.mjs (discord.js)  --writes-->  inbox.jsonl  --pings-->  webhook
        ^                                          |
        |        (agent reads inbox, decides)      v
reply.mjs <------------------ agent loop  <--- notification
```

- `bot.mjs` — Discord client + localhost agent API
- `reply.mjs` — CLI: send a message or threaded reply through the bot
- `inbox.jsonl` — append-only log of inbound messages for the agent to consume
- systemd unit: `discord-bot.service` (user-level, auto-restart)

## Setup

1. Create a bot in the Discord Developer Portal and enable the
   **Message Content** intent (and bot scopes: Send Messages, Read Messages,
   Read Message History, Use Slash Commands if wanted).
2. Put the token in a secrets file your code reads at runtime — it is **never
   committed**:
   ```
   discord-bot-token: MTxxxx...
   ```
3. `npm install`
4. `node bot.mjs` (or `systemctl --user enable --now discord-bot`)
5. Add the bot to a server, or DM it. `@John hi` — done.

## Reply from the agent side

```bash
node reply.mjs <channelId> - "hello world"           # plain message
node reply.mjs <channelId> <messageId> "hello"       # threaded reply
```

## Security notes

- The token lives only in the runtime secrets file (e.g. `/home/lemion/logins`),
  read at startup — never echoed, never in the repo, never in logs.
- The agent API binds to `127.0.0.1` only.
- Webhook notifications are best-effort and carry short masked previews.

## License

MIT
