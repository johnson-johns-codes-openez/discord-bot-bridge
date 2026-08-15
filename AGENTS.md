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
  - Attachments on DMs/mentions are downloaded (bot-token-authed), text-ish
    files (csv/json/text) inlined into the log records, binaries saved to
    /tmp/opencode/attachments/, and file names appended to the brain prompt.
  - Localhost HTTP API on 127.0.0.1:8757 (VM-local):
    - `POST /msg {channelId, content}` — send a text message as the bot
    - `POST /img {channelId, image, caption?}` — send an image as the bot
    - `POST /file {channelId, path, caption?}` — send any file as the bot
    - `GET /health` — health check
- `reply.mjs` — CLI to reply from the bot:
  `node reply.mjs <channelId> [msgId] "<text>"` (threaded if msgId given).
- `wait.mjs` — signal-aware wait for the agent loop (replaces plain sleep):
  polls for queued agent-requests, inbox lines the brain could NOT auto-answer,
  watcher feed changes, GitHub thread state changes (#727/#728/#846), bridge
  health, honeygain container, disk/RAM. Prints `SIGNAL: ...` + exit 3 on
  activity, `TIMEOUT` + exit 0. Chat the brain handled does NOT wake the agent.
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
→ `@cf/moonshotai/kimi-k2.5` → `@cf/google/gemma-4-26b-a4b-it`
(fallback on empty/capacity errors).
`POST /vision` with `Authorization: Bearer <brain-secret>` and body
`{ prompt, image }` (image = base64 PNG, <=4MB) → `{ text, model }` using
`@cf/meta/llama-3.2-11b-vision-instruct` (license already accepted on the
account via the `prompt:"agree"` flow — do not re-agree). Requires at least
a system + user text message; image goes in the top-level `image` field as a
data: URL (image_url content parts are rejected by the binding).
Source: `/home/lemion/workers/discord-brain` (wrangler.jsonc, src/index.js).
Brain secret lives in the logins file keyed `brain-secret:` — read at runtime,
never commit, never echo.

## Running

```bash
systemctl --user restart discord-bot      # service: discord-bot.service
journalctl --user -u discord-bot -f       # logs
curl -s http://127.0.0.1:8757/health      # -> ok
```

## Slash commands (owner-only)

- `/john status` — full rig report: agent pid, bridge, brain worker, honeygain,
  watcher timers, jumble daemon, pending messages/requests, money, thread states.
- `/john restart` — spawns a fresh `opencode run` (resume-prompt.txt) only if the
  agent process is dead; reports already-alive otherwise.

## Watchdog (autonomous recovery)

`agent-watchdog.mjs` runs every 10 min via the `agent-watchdog.timer` systemd
user timer. If the opencode agent is dead AND the bridge is up AND the last
spawn was >15 min ago, it spawns a fresh run (log: /home/lemion/opencode-agent.log).
No-op when the agent is alive.

## Contribution rules

- Never commit tokens or secrets (logins file is outside the repo).
- The bot speaks for "John's assistant", never claims to BE John.
- Keep persona: friendly, concise, honest. Honest money reporting only.
