#!/usr/bin/env node
// Generate heatmap.svg from GitHub GraphQL contributionCalendar.
//
// Run in CI:    GITHUB_TOKEN=... node scripts/generate-heatmap.mjs
// Run locally:  node scripts/generate-heatmap.mjs --fake   (deterministic seed)

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const USER = 'Yansoul'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SVG_PATH = path.resolve(__dirname, '..', 'heatmap.svg')

const token = process.env.GH_PAT || process.env.GITHUB_TOKEN || ''
const fakeMode = process.argv.includes('--fake') || !token

// ─── geometry ────────────────────────────────────────────────────────────────
const VIEW_W = 800
const VIEW_H = 220
const CARD_X = 60
const CARD_Y = 20
const CARD_W = 680
const CARD_H = 180
const FRAME_Y = CARD_Y + 22  // 42
const FRAME_W = CARD_W - 36  // 644
const FRAME_H = CARD_H - 44  // 136
const COLS = 53
const ROWS = 7
const CELL = 9
const GAP = 2
const GRID_X = 102
const GRID_Y = 88
const GRID_W = COLS * (CELL + GAP) - GAP // 581
const GRID_H = ROWS * (CELL + GAP) - GAP // 75

// ─── palette ─────────────────────────────────────────────────────────────────
const LEVEL_COLORS = ['#d4dde7', '#b6c8d8', '#5a8aa8', '#1c3a58', '#0e1e30']

function level(count) {
  if (count === 0) return 0
  if (count <= 3) return 1
  if (count <= 7) return 2
  if (count <= 15) return 3
  return 4
}

// ─── data ────────────────────────────────────────────────────────────────────
async function fetchReal() {
  const r = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'yansoul-readme-bot',
    },
    body: JSON.stringify({
      query: `query($user:String!){
        user(login:$user){
          contributionsCollection{
            contributionCalendar{
              totalContributions
              weeks{
                contributionDays{ date contributionCount }
              }
            }
          }
        }
      }`,
      variables: { user: USER },
    }),
  })
  if (!r.ok) throw new Error(`GraphQL ${r.status}: ${(await r.text()).slice(0, 200)}`)
  const j = await r.json()
  if (j.errors) throw new Error(JSON.stringify(j.errors))
  return j.data.user.contributionsCollection.contributionCalendar
}

function generateFake() {
  // Deterministic seed so commits are stable across runs.
  function rand(n) {
    let t = (n + 0xdeadbeef) | 0
    t = Math.imul(t ^ (t >>> 15), 0x2c1b3c6d)
    t = Math.imul(t ^ (t >>> 12), 0x297a2d39)
    return ((t ^ (t >>> 15)) >>> 0) / 4_294_967_296
  }

  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  // Align start to Sunday of (today - 52 weeks).
  const start = new Date(today)
  start.setUTCDate(start.getUTCDate() - 52 * 7 - start.getUTCDay())

  const weeks = []
  let total = 0
  const cursor = new Date(start)
  for (let w = 0; w < COLS; w++) {
    const days = []
    for (let d = 0; d < ROWS; d++) {
      if (cursor > today) break
      const dow = cursor.getUTCDay()
      // Plausible activity: a slow sinusoid + weekday boost + jitter.
      const base = Math.sin((w + d / 7) / 7) * 1.4 + 1.6
      const weekday = (dow === 0 || dow === 6) ? -0.7 : 0.5
      const r = rand(w * 7 + d)
      const lvl = Math.max(0, Math.min(4, Math.round(base + weekday + (r - 0.5) * 1.8)))
      const count = [0, 2, 5, 10, 20][lvl]
      total += count
      days.push({
        date: cursor.toISOString().slice(0, 10),
        contributionCount: count,
      })
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
    weeks.push({ contributionDays: days })
  }
  return { weeks, totalContributions: total }
}

// ─── render fragments ────────────────────────────────────────────────────────
function renderCells(weeks) {
  const out = []
  for (let w = 0; w < weeks.length; w++) {
    for (let d = 0; d < weeks[w].contributionDays.length; d++) {
      const day = weeks[w].contributionDays[d]
      const lv = level(day.contributionCount)
      const x = GRID_X + w * (CELL + GAP)
      const y = GRID_Y + d * (CELL + GAP)
      out.push(`    <rect class="cell" x="${x}" y="${y}" width="${CELL}" height="${CELL}" fill="${LEVEL_COLORS[lv]}" stroke="#1f1f1f" stroke-width="0.3" style="--c:${w}"><title>${day.date}: ${day.contributionCount}</title></rect>`)
    }
  }
  return out.join('\n')
}

function renderMonths(weeks) {
  const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']
  const out = []
  let lastMonth = -1
  for (let w = 0; w < weeks.length; w++) {
    const first = weeks[w].contributionDays[0]
    if (!first) continue
    const m = new Date(first.date + 'T00:00:00Z').getUTCMonth()
    if (m !== lastMonth) {
      // Skip a label if there's less than ~3 columns to the next change (too tight).
      const x = GRID_X + w * (CELL + GAP)
      if (lastMonth === -1 && w < 1) {
        lastMonth = m
        continue
      }
      out.push(`  <text x="${x}" y="${GRID_Y - 6}" class="mono" font-size="8" letter-spacing="1.5" fill="#1c3a58">${MONTHS[m]}</text>`)
      lastMonth = m
    }
  }
  return out.join('\n')
}

function renderDayLabels() {
  const labelX = GRID_X - 8
  return [
    [1, 'MON'],
    [3, 'WED'],
    [5, 'FRI'],
  ].map(([d, label]) => {
    const y = GRID_Y + d * (CELL + GAP) + 7
    return `  <text x="${labelX}" y="${y}" class="mono" font-size="7" letter-spacing="1.2" fill="#1c3a58" text-anchor="end">${label}</text>`
  }).join('\n')
}

function renderLegend(legendY) {
  const legendX = 562
  const items = LEVEL_COLORS.map((c, i) =>
    `  <rect x="${legendX + i * 12}" y="${legendY - 8}" width="9" height="9" fill="${c}" stroke="#1f1f1f" stroke-width="0.3"/>`
  ).join('\n')
  return [
    `  <text x="${legendX - 4}" y="${legendY - 1}" class="mono" font-size="7" letter-spacing="1.2" fill="#1f1f1f" text-anchor="end">LESS</text>`,
    items,
    `  <text x="${legendX + 5 * 12 + 4}" y="${legendY - 1}" class="mono" font-size="7" letter-spacing="1.2" fill="#1f1f1f">MORE</text>`,
  ].join('\n')
}

function renderBadge(total, legendY) {
  return `  <g class="badge" transform="translate(132, ${legendY - 3})">
    <rect x="-52" y="-12" width="104" height="20" fill="#c54138"/>
    <text x="0" y="3" class="serif" font-size="11" font-weight="900" fill="#e3e9f0" text-anchor="middle" font-style="italic">★ ${total} STAMPS</text>
  </g>`
}

// ─── full SVG ────────────────────────────────────────────────────────────────
function buildSvg({ weeks, totalContributions }) {
  const cells = renderCells(weeks)
  const months = renderMonths(weeks)
  const dayLabels = renderDayLabels()
  const legendY = GRID_Y + GRID_H + 18 // 88 + 75 + 18 = 181 (just inside frame at 178)... clamp:
  const legendYClamped = Math.min(legendY, FRAME_Y + FRAME_H - 6) // 178 - 6 = 172
  const legend = renderLegend(legendYClamped)
  const badge = renderBadge(totalContributions.toLocaleString('en-US'), legendYClamped)

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW_W} ${VIEW_H}" role="img" aria-label="Yansoul · Contribution heatmap" style="font-family: 'Iowan Old Style', 'Palatino', 'Georgia', 'Times New Roman', serif;">
  <defs>
    <style>
      .serif { font-family: 'Iowan Old Style', 'Palatino', 'Georgia', 'Times New Roman', serif; }
      .mono  { font-family: 'Courier New', 'Courier', 'Menlo', monospace; }

      .cell {
        opacity: 0;
        transform-box: fill-box; transform-origin: center;
        animation: cell-pop-loop 10s cubic-bezier(.2,.7,.3,1.2) infinite;
        animation-delay: calc(.15s + var(--c) * 18ms);
      }
      @keyframes cell-pop-loop {
        0%   { opacity: 0; transform: scale(.45) rotate(-6deg); }
        2.7% { opacity: 1; transform: scale(1.12) rotate(1deg); }
        4.2% { opacity: 1; transform: scale(1) rotate(0); }
        70%  { opacity: 1; transform: scale(1) rotate(0); }
        92%  { opacity: 0; transform: scale(1) rotate(0); }
        100% { opacity: 0; transform: scale(.45) rotate(-6deg); }
      }

      .sweep {
        opacity: 0;
        animation: sweep-loop 10s linear infinite;
      }
      @keyframes sweep-loop {
        0%, 22%  { opacity: 0;    transform: translateX(0); }
        25%      { opacity: 0.55; transform: translateX(0); }
        38%      { opacity: 0.55; transform: translateX(${GRID_W}px); }
        42%      { opacity: 0;    transform: translateX(${GRID_W + 40}px); }
        43%      { opacity: 0;    transform: translateX(0); }
        100%     { opacity: 0;    transform: translateX(0); }
      }

      .badge {
        transform-box: fill-box; transform-origin: center;
        animation: pulse 3.4s ease-in-out infinite;
      }
      @keyframes pulse {
        0%, 100% { opacity: .92; transform: scale(1); }
        50%      { opacity: 1;   transform: scale(1.03); }
      }

      .postmark {
        transform-box: fill-box; transform-origin: center;
        animation: pulse 3.4s ease-in-out infinite;
      }
    </style>
    <pattern id="hPaper" patternUnits="userSpaceOnUse" width="220" height="220">
      <rect width="220" height="220" fill="#e3e9f0"/>
      <circle cx="40"  cy="30"  r="0.7" fill="#b8c2cd" opacity="0.35"/>
      <circle cx="120" cy="80"  r="0.6" fill="#b8c2cd" opacity="0.35"/>
      <circle cx="170" cy="150" r="0.8" fill="#b8c2cd" opacity="0.35"/>
      <circle cx="60"  cy="170" r="0.5" fill="#b8c2cd" opacity="0.35"/>
    </pattern>
    <pattern id="hStripes" patternUnits="userSpaceOnUse" width="22" height="22" patternTransform="rotate(45)">
      <rect width="22" height="22" fill="#e3e9f0"/>
      <rect x="0"  y="0"  width="11" height="11" fill="#c54138"/>
      <rect x="11" y="11" width="11" height="11" fill="#1c3a58"/>
    </pattern>
    <linearGradient id="sweepGrad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0"   stop-color="#e3e9f0" stop-opacity="0"/>
      <stop offset="0.5" stop-color="#e3e9f0" stop-opacity="0.85"/>
      <stop offset="1"   stop-color="#e3e9f0" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <rect width="${VIEW_W}" height="${VIEW_H}" fill="#cfd8e3"/>

  <g transform="translate(${CARD_X}, ${CARD_Y})">
    <rect width="${CARD_W}" height="${CARD_H}" fill="url(#hPaper)" stroke="#1f1f1f" stroke-width="1.5"/>
    <rect x="0" y="0"             width="${CARD_W}" height="10" fill="url(#hStripes)" opacity="0.85"/>
    <rect x="0" y="${CARD_H - 10}" width="${CARD_W}" height="10" fill="url(#hStripes)" opacity="0.85"/>
    <rect x="18" y="22" width="${FRAME_W}" height="${FRAME_H}" fill="none" stroke="#1c3a58" stroke-width="1"/>

    <text x="30"  y="44" class="serif" font-size="11" letter-spacing="3.5" fill="#1c3a58" font-weight="700">CONTRIBUTION ALMANAC</text>
    <text x="${CARD_W - 30}" y="44" class="serif" font-size="10" letter-spacing="2" fill="#1f1f1f" text-anchor="end">TRAILING 365 DAYS · ROUTING ∞</text>
    <line x1="30" y1="52" x2="${CARD_W - 30}" y2="52" stroke="#1c3a58" stroke-width="0.5"/>
  </g>

${months}

${dayLabels}

${cells}

  <rect class="sweep" x="${GRID_X - 80}" y="${GRID_Y - 2}" width="80" height="${GRID_H + 4}" fill="url(#sweepGrad)"/>

${legend}

${badge}
</svg>
`
}

// ─── main ────────────────────────────────────────────────────────────────────
async function main() {
  const cal = fakeMode ? generateFake() : await fetchReal()
  const svg = buildSvg(cal)
  await fs.writeFile(SVG_PATH, svg)
  const label = fakeMode ? 'fake' : 'live'
  console.log(`Wrote ${path.relative(process.cwd(), SVG_PATH)} (${label}, total=${cal.totalContributions}).`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
