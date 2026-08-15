#!/usr/bin/env node
// Watchdog: restart John's agent (opencode) if it died, autonomously.
// Idempotent: no-op if the agent is alive, the bridge is down, or a spawn
// happened <15min ago (cooldown against respawn loops). Logs to AGENT_LOG.
import fs from 'node:fs'
import { execSync, spawn } from 'node:child_process'

const RESUME = fs.readFileSync('/home/lemion/discord-bot/resume-prompt.txt', 'utf8').trim()
const MARK = '/tmp/opencode/.agent-last-spawn'
const LOG = '/home/lemion/opencode-agent.log'

function alive() {
  try {
    const out = execSync('pgrep -x opencode || true', { encoding: 'utf8', timeout: 8000 }).trim()
    return out.split('\n').some((p) => /^\d+$/.test(p.trim()))
  } catch {
    return false
  }
}

function bridgeOk() {
  try {
    return execSync('curl -s -m 4 http://127.0.0.1:8757/health', { encoding: 'utf8', timeout: 8000 }).trim() === 'ok'
  } catch {
    return false
  }
}

function lastSpawn() {
  try {
    return Number(fs.readFileSync(MARK, 'utf8').trim()) || 0
  } catch {
    return 0
  }
}

if (alive()) {
  process.exit(0)
}
if (!bridgeOk()) {
  process.exit(0) // no supervisor up - don't blindly spawn
}
if (Date.now() - lastSpawn() < 15 * 60 * 1000) {
  process.exit(0) // cooldown
}

fs.mkdirSync('/tmp/opencode', { recursive: true })
fs.writeFileSync(MARK, String(Date.now()))
fs.appendFileSync(LOG, `[watchdog ${new Date().toISOString()}] agent dead, bridge up - spawning opencode run\n`)
const fd = fs.openSync(LOG, 'a')
const child = spawn('/usr/bin/opencode', ['run', RESUME], { detached: true, stdio: ['ignore', fd, fd] })
child.unref()
console.log('watchdog: spawned agent run')
