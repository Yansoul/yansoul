#!/usr/bin/env node
// Slot-fill the 5 commit rows in dispatch-log.svg with the latest pushes
// from /users/<USER>/events/public.
//
// As of 2024, the user-events feed strips payload.commits — only payload.head
// (the head SHA) is included. We fetch each commit message via
// /repos/<owner>/<repo>/commits/<sha> for the head of each push.
//
// Safety: if zero commits are pickable, the existing SVG is left untouched.
//
// Run in CI:    GITHUB_TOKEN=... node scripts/generate-dispatch.mjs
// Run locally:  node scripts/generate-dispatch.mjs       (unauth, 60 req/h)

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const USER = 'Yansoul'
const PROFILE_REPO = 'yansoul'
const ROW_COUNT = 5
const MSG_MAX = 50
const MAX_LOOKUPS = 12 // hard cap on commit-detail API calls per run

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SVG_PATH = path.resolve(__dirname, '..', 'dispatch-log.svg')

const token = process.env.GH_PAT || process.env.GITHUB_TOKEN || ''
const baseHeaders = {
  'User-Agent': 'yansoul-readme-bot',
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
}
if (token) baseHeaders.Authorization = `Bearer ${token}`

async function ghJson(url) {
  const r = await fetch(url, { headers: baseHeaders })
  if (!r.ok) {
    const body = await r.text()
    throw new Error(`GitHub ${r.status} on ${url}: ${body.slice(0, 200)}`)
  }
  return r.json()
}

async function fetchEvents() {
  const out = []
  for (let page = 1; page <= 3; page++) {
    const batch = await ghJson(`https://api.github.com/users/${USER}/events/public?per_page=100&page=${page}`)
    if (!Array.isArray(batch) || batch.length === 0) break
    out.push(...batch)
    if (batch.length < 100) break
  }
  return out
}

const SKIP_PATTERNS = [
  /^chore:\s+refresh/i,
  /\[skip ci\]/i,
  /^merge\s+pull\s+request/i,
  /^merge\s+branch/i,
]

async function pickCommits(events) {
  const out = []
  let lookups = 0
  for (const ev of events) {
    if (ev.type !== 'PushEvent') continue
    const repoFull = ev.repo?.name
    const repo = repoFull?.split('/').pop() || ''
    const head = ev.payload?.head
    if (!repoFull || !head) continue
    if (lookups >= MAX_LOOKUPS) break

    lookups++
    let detail
    try {
      detail = await ghJson(`https://api.github.com/repos/${repoFull}/commits/${head}`)
    } catch (e) {
      console.warn(`  skip ${repoFull}@${head.slice(0, 7)}: ${e.message}`)
      continue
    }
    const fullMsg = detail.commit?.message || ''
    const msg = fullMsg.split('\n')[0].trim()
    if (!msg) continue
    if (SKIP_PATTERNS.some(p => p.test(msg))) continue

    out.push({
      sha: head.slice(0, 7),
      repo,
      message: msg,
      when: new Date(ev.created_at),
    })
    if (out.length >= ROW_COUNT) return out
  }
  return out
}

function relativeTime(date) {
  const diff = Date.now() - date.getTime()
  const min = 60_000, hour = 3_600_000, day = 86_400_000
  if (diff < hour) {
    const n = Math.max(1, Math.floor(diff / min))
    return `${n} min`
  }
  if (diff < day) {
    const n = Math.floor(diff / hour)
    return `${n} hour${n === 1 ? '' : 's'}`
  }
  if (diff < 2 * day) return '1 day'
  if (diff < 7 * day) return `${Math.floor(diff / day)} days`
  if (diff < 14 * day) return '1 week'
  if (diff < 30 * day) return `${Math.floor(diff / (7 * day))} weeks`
  if (diff < 60 * day) return '1 month'
  return `${Math.floor(diff / (30 * day))} months`
}

function truncate(s, n) {
  const arr = [...s]
  return arr.length <= n ? s : arr.slice(0, n - 1).join('') + '…'
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, c => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
  }[c]))
}

function renderRow(i, c) {
  const y = 86 + i * 32
  const textY = y + 16
  const msgRaw = c.repo === PROFILE_REPO || !c.repo
    ? c.message
    : `${c.repo}: ${c.message}`
  const msg = truncate(msgRaw, MSG_MAX)
  return `    <g class="row r${i + 1}">
      <rect x="28" y="${y}" width="74" height="22" fill="none" stroke="#1c3a58" stroke-width="1.2"/>
      <text x="65" y="${y + 15}" class="mono" font-size="9" letter-spacing="1.4" fill="#c54138" font-weight="700" text-anchor="middle">★ POSTED</text>
      <text x="118" y="${textY}" class="mono" font-size="11" fill="#1f1f1f">${escapeXml(c.sha)}</text>
      <text x="206" y="${textY}" class="mono" font-size="11" fill="#1f1f1f">${escapeXml(msg)}</text>
      <text x="650" y="${textY}" class="mono" font-size="10" fill="#1f1f1f" text-anchor="end">${escapeXml(relativeTime(c.when))}</text>
    </g>`
}

function renderEmptyRow(i) {
  const y = 86 + i * 32
  const textY = y + 16
  return `    <g class="row r${i + 1}">
      <rect x="28" y="${y}" width="74" height="22" fill="none" stroke="#1c3a58" stroke-width="1.2" stroke-dasharray="2 2" opacity="0.4"/>
      <text x="65" y="${y + 15}" class="mono" font-size="9" letter-spacing="1.4" fill="#1c3a58" font-weight="700" text-anchor="middle" opacity="0.4">- PEND -</text>
      <text x="118" y="${textY}" class="mono" font-size="11" fill="#1f1f1f" opacity="0.45">·······</text>
      <text x="206" y="${textY}" class="mono" font-size="11" fill="#1f1f1f" opacity="0.45">awaiting next dispatch</text>
      <text x="650" y="${textY}" class="mono" font-size="10" fill="#1f1f1f" text-anchor="end" opacity="0.45">—</text>
    </g>`
}

async function main() {
  const events = await fetchEvents()
  const commits = await pickCommits(events)
  console.log(`Picked ${commits.length}/${ROW_COUNT} commit(s) from ${events.length} event(s).`)

  if (commits.length === 0) {
    console.log('No commits found — leaving dispatch-log.svg unchanged.')
    return
  }

  const rows = []
  for (let i = 0; i < ROW_COUNT; i++) {
    rows.push(i < commits.length ? renderRow(i, commits[i]) : renderEmptyRow(i))
  }

  const svg = await fs.readFile(SVG_PATH, 'utf8')
  const re = /    <!-- COMMITS:START -->[\s\S]*?    <!-- COMMITS:END -->/
  if (!re.test(svg)) {
    throw new Error('Markers <!-- COMMITS:START/END --> not found in dispatch-log.svg')
  }
  const block = `    <!-- COMMITS:START -->\n${rows.join('\n\n')}\n    <!-- COMMITS:END -->`
  const next = svg.replace(re, block)

  if (next === svg) {
    console.log('No change.')
    return
  }
  await fs.writeFile(SVG_PATH, next)
  console.log(`Updated ${path.relative(process.cwd(), SVG_PATH)}.`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
