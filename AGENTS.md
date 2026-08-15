# Discord Bridge Bot — "John's assistant"

Discord bridge that lets humans and other AI agents talk to the autonomous
earnings agent "John" (Johnson John Codes Openez) that runs on a VM.

## Architecture

- `bot.mjs` — Discord bot (discord.js). Reads the token from the runtime
  environment: logins file, key `discord-bot-token:` (never commit it).
  - DMs and @mentions only (intents: Guilds, GuildMessages, DirectMessages,
    MessageContent).
  - Trivial queries → local `quickAnswer`.
  - Everything else → brain worker `/chat` (Workers AI) with the briefing.
  - Brain says `needs_agent` → append to `agent-requests.jsonl`, ping webhook;
    sender is told John will pick it up on his next poll.
  - Every message logged to `inbox.jsonl`.
  - Localhost HTTP API on 127.0.0.1:8757 (VM-local):
    - `POST /msg {channelId, content}` — send a text message as the bot
    - `POST /img {channelId, image, caption?}` — send an image as the bot
    - `GET /health` — health check
- `reply.mjs` — CLI to reply from the bot:
  `node reply.mjs <channelId> [msgId] "<text>"` (threaded if msgId given).
- `wait.mjs` — signal-aware wait for the agent loop (replaces plain sleep):
  polls for new agent-requests/inbox lines, watcher feed changes, GitHub
  thread state changes (#727/#728/#846), bridge health, honeygain container,
  disk/RAM. Prints `SIGNAL: ...` + exit 3 on activity, `TIMEOUT` + exit 0.
- `briefing.md` — secret-free operating brief, refreshed by the agent; sent to
  the brain on every request.
- Marker files (agent-side, don't commit): `.last-replied-line` (inbox lines
  the agent has replied to), `.agent-request-count` (queued requests handled).

## Brain worker

`POST https://discord-brain.johnson-johns-codes-openez.workers.dev/chat`
with `Authorization: Bearer <brain-secret>` and body
`{ messages: [{role, content}], briefing?: string }`.
Returns `{ reply, needs_agent, agent_task, model }`.
Models: `@cf/zai-org/glm-4.7-flash` → `@cf/meta/llama-4-scout-17b-16e-instruct`
→ `@cf/google/gemma-4-26b-a4b-it` (fallback on empty/capacity errors).
Source: `/home/lemion/workers/discord-brain` (wrangler.jsonc, src/index.js).
Brain secret lives in the logins file keyed `brain-secret:` — read at runtime,
never commit, never echo.

## Running

```bash
systemctl --user restart discord-bot      # service: discord-bot.service
journalctl --user -u discord-bot -f       # logs
curl -s http://127.0.0.1:8757/health      # -> ok
```

## Contribution rules

- Never commit tokens or secrets (logins file is outside the repo).
- The bot speaks for "John's assistant", never claims to BE John.
- Keep persona: friendly, concise, honest. Honest money reporting only.
