#!/usr/bin/env node
// wait.mjs - signal-aware wait for the agent loop.
// Blocks (default 1500s, override: node wait.mjs <seconds>), polling every 15s for
// things that need the agent's attention. On signal: prints "SIGNAL: <what>" plus a
// short "must do" note and exits 3. On clean timeout: prints "TIMEOUT" and exits 0.
//
// Signals checked:
//  - agent-requests.jsonl beyond .agent-request-count      -> real action queued
//  - inbox.jsonl beyond .last-replied-line (brain FAILED to answer, i.e. the
//    bot could not auto-answer and John must respond manually)
//  - watcher seen-file mtimes (lb/sphinx/agent-feed/jumble) -> feed activity
//  - GitHub thread states (#727 #728 sphinx-swarm, #846 jumble) -> status change
//  - discord-bot bridge health (127.0.0.1:8757)             -> bridge down
//  - honeygain container running?                           -> passive income down
//  - disk > 90% used or RAM < 300MB free                    -> VM trouble
import fs from 'node:fs'
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const WAIT = Number(process.argv[2] || 1500)
const POLL = 15
const TOP = '/home/lemion'
const AGENT_REQS = `${TOP}/discord-bot/agent-requests.jsonl`
const INBOX = `${TOP}/discord-bot/inbox.jsonl`
const REQ_MARK = `${TOP}/discord-bot/.agent-request-count`
const INBOX_MARK = `${TOP}/discord-bot/.last-replied-line`
const STATE_FILE = '/tmp/opencode/wait-state.json'
const FEEDS = [
  `${TOP}/bounties/lb-real-seen.json`,
  `${TOP}/bounties/sphinx-seen.json`,
  `${TOP}/bounties/agent-feed-seen.json`,
  `${TOP}/bounties/jumble-seen.json`,
]
const ISSUES = [
  ['stakwork/sphinx-swarm', 727],
  ['stakwork/sphinx-swarm', 728],
  ['CodyTseng/jumble', 846],
]

const log = (m) => console.log(m)
let start = Date.now()

function lineCount(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

function readMark(file) {
  try {
    return Number(fs.readFileSync(file, 'utf8').trim()) || 0
  } catch {
    return 0
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function issueStates() {
  const out = {}
  for (const [repo, num] of ISSUES) {
    try {
      const s = execSync(
        `gh api repos/${repo}/issues/${num} --jq .state 2>/dev/null`,
        { timeout: 10000, encoding: 'utf8' }
      ).trim()
      out[`${repo}#${num}`] = s
    } catch {
      /* skip */
    }
  }
  return out
}

function signals() {
  const hits = []

  const reqs = lineCount(AGENT_REQS)
  const reqMark = readMark(REQ_MARK)
  if (reqs > reqMark) {
    const lines = fs
      .readFileSync(AGENT_REQS, 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(reqMark)
    const last = lines.length ? JSON.parse(lines[lines.length - 1]) : null
    hits.push(
      `agent-request queued by ${last ? last.author : '?'}: "${last ? last.task : '?'}" ` +
        `(total ${reqs}) - MUST DO: read it, act, then bump .agent-request-count to ${reqs}`
    )
  }

  const inbox = lineCount(INBOX)
  const inboxMark = readMark(INBOX_MARK)
  if (inbox > inboxMark) {
    // Only wake the agent for messages the BRAIN could not auto-answer
    // (brainReply null / brainErr). Chat the brain handled needs no agent.
    const lines = fs
      .readFileSync(INBOX, 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(inboxMark)
    const unattended = lines.filter((l) => {
      try {
        const e = JSON.parse(l)
        return e.brainReply === null || e.brainReply === undefined || e.brainErr
      } catch {
        return true
      }
    })
    if (unattended.length) {
      const last = JSON.parse(unattended[unattended.length - 1])
      hits.push(
        `brain could not answer ${unattended.length} message(s) (line ${inboxMark}+, last by ${last.author}: "${(last.content || '').slice(0, 80)}") - MUST DO: reply manually, then bump .last-replied-line to ${inbox}`
      )
    }
  }

  const st = readJson(STATE_FILE) || {}
  const prevFeeds = st.feeds || {}
  for (const f of FEEDS) {
    try {
      const data = fs.readFileSync(f)
      const hash = createHash('md5').update(data).digest('hex')
      if (prevFeeds[f] && prevFeeds[f] !== hash) {
        hits.push(`feed changed: ${f} - MUST DO: inspect new bounties and decide`)
      }
      prevFeeds[f] = hash
    } catch {
      /* missing file - fine */
    }
  }

  const states = issueStates()
  const prevIssues = st.issues || {}
  for (const [k, v] of Object.entries(states)) {
    if (prevIssues[k] && prevIssues[k] !== v) {
      hits.push(`thread ${k} now ${v} (was ${prevIssues[k]}) - MUST DO: act (claim/update/comment)`)
    }
  }

  try {
    const h = execSync('curl -s -m 5 http://127.0.0.1:8757/health', { encoding: 'utf8' }).trim()
    if (h !== 'ok') hits.push(`discord bridge /health -> "${h}" - MUST DO: systemctl --user restart discord-bot`)
  } catch {
    hits.push(`discord bridge /health unreachable - MUST DO: systemctl --user restart discord-bot`)
  }

  try {
    const hg = execSync(
      `sudo -n docker ps --filter name=^honeygain$ --format {{.Status}} 2>/dev/null`,
      { encoding: 'utf8' }
    ).trim()
    if (hg && !/Up/i.test(hg)) hits.push(`honeygain container state "${hg}" - MUST DO: restart it`)
  } catch {
    /* sudo -n unavailable - skip */
  }

  try {
    const used = execSync(`df / | awk 'NR==2{print $5}'`, { encoding: 'utf8' }).trim().replace('%', '')
    if (Number(used) > 90) hits.push(`disk ${used}% used - MUST DO: clean up`)
  } catch {
    /* skip */
  }
  try {
    const avail = execSync(`free -m | awk '/Mem:/{print $7}'`, { encoding: 'utf8' }).trim()
    if (Number(avail) < 300) hits.push(`RAM only ${avail}MB free - MUST DO: check processes`)
  } catch {
    /* skip */
  }

  fs.mkdirSync('/tmp/opencode', { recursive: true })
  fs.writeFileSync(STATE_FILE, JSON.stringify({ feeds: prevFeeds, issues: states }))
  return hits
}

while (Date.now() - start < WAIT * 1000) {
  const hits = signals()
  if (hits.length) {
    for (const h of hits) log('SIGNAL: ' + h)
    log(`[wait.mjs] exiting on ${hits.length} signal(s)`)
    process.exit(3)
  }
  if (Date.now() - start < WAIT * 1000) {
    execSync(`sleep ${POLL}`, { stdio: 'ignore' })
  }
}
log('TIMEOUT: nothing needed attention')
process.exit(0)
