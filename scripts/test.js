#!/usr/bin/env node

/**
 * Custom test runner for Pitwall backend.
 *
 * Usage:
 *   node scripts/test.js               → run all tests
 *   node scripts/test.js formatters    → run tests matching "formatters"
 *   node scripts/test.js dashboard     → run dashboardService tests
 */

import { execSync }  from 'child_process'
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT      = join(__dirname, '..')
const LOGS_DIR  = join(ROOT, 'logs')
const TMP_JSON  = join(ROOT, '.vitest-results.json')

// ── ANSI colours ───────────────────────────────────────────────────────────────
const GREEN  = s => `\x1b[32m${s}\x1b[0m`
const RED    = s => `\x1b[31m${s}\x1b[0m`
const YELLOW = s => `\x1b[33m${s}\x1b[0m`
const BOLD   = s => `\x1b[1m${s}\x1b[0m`
const DIM    = s => `\x1b[2m${s}\x1b[0m`

// ── Timestamp helper ───────────────────────────────────────────────────────────
function timestamp() {
  const d   = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`
       + `-${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
}

// ── Run Vitest with JSON reporter ──────────────────────────────────────────────
function runVitest(pattern) {
  const patternArg = pattern ? ` ${pattern}` : ''
  const cmd = `npx vitest run${patternArg} --reporter=json --outputFile=${TMP_JSON}`

  try {
    execSync(cmd, { cwd: ROOT, stdio: 'pipe' })
    return 0
  } catch (err) {
    // Vitest exits with code 1 when tests fail — that's expected
    return err.status ?? 1
  }
}

// ── Parse Vitest JSON output ───────────────────────────────────────────────────
function parseResults() {
  try {
    return JSON.parse(readFileSync(TMP_JSON, 'utf8'))
  } catch {
    return null
  }
}

// ── Format results into lines ──────────────────────────────────────────────────
function buildReport(json) {
  const lines     = []   // plain text (for log file)
  const terminal  = []   // with ANSI (for stdout)

  let totalPass = 0
  let totalFail = 0
  let totalSkip = 0

  for (const suite of json.testResults ?? []) {
    // Show relative path like  src/services/dashboardService.test.js
    const rel = (suite.name ?? suite.testFilePath ?? '').replace(ROOT + '/', '')

    lines.push(`\n── ${rel}`)
    terminal.push(`\n${BOLD(DIM('──'))} ${BOLD(rel)}`)

    for (const t of suite.assertionResults ?? []) {
      const name   = t.fullName || t.title
      const status = t.status   // 'passed' | 'failed' | 'pending' | 'todo'

      if (status === 'passed') {
        totalPass++
        lines.push(`  ✓  ${name}`)
        terminal.push(`  ${GREEN('✓')}  ${name}`)

      } else if (status === 'failed') {
        totalFail++
        const reason = (t.failureMessages ?? [])
          .map(m => m.split('\n').slice(0, 4).join('\n'))   // first 4 lines
          .join('\n')
          .trim()

        lines.push(`  ✗  ${name}`)
        lines.push(`     → ${reason.replace(/\n/g, '\n       ')}`)
        terminal.push(`  ${RED('✗')}  ${name}`)
        terminal.push(`     ${RED('→')} ${reason.replace(/\n/g, '\n       ')}`)

      } else {
        totalSkip++
        lines.push(`  -  ${name}  (${status})`)
        terminal.push(`  ${YELLOW('-')}  ${name}  ${DIM(`(${status})`)}`)
      }
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  const summaryLine = `\nResults: ${totalPass} passed  ${totalFail} failed  ${totalSkip} skipped  (${totalPass+totalFail+totalSkip} total)`
  lines.push(summaryLine)

  const colorSummary = `\n${GREEN(`${totalPass} passed`)}  `
    + (totalFail ? RED(`${totalFail} failed`) + '  ' : DIM(`${totalFail} failed`) + '  ')
    + DIM(`${totalSkip} skipped`)
    + `  (${totalPass+totalFail+totalSkip} total)`
  terminal.push(colorSummary)

  return { lines, terminal, totalPass, totalFail }
}

// ── Main ───────────────────────────────────────────────────────────────────────
const pattern  = process.argv[2] ?? null
const ts       = timestamp()

console.log(BOLD(`\nPitwall test runner  ${DIM(ts)}`))
if (pattern) console.log(`Filter: ${YELLOW(pattern)}\n`)

const exitCode = runVitest(pattern)
const json     = parseResults()

if (!json) {
  console.error(RED('\nCould not read test results — check that Vitest is installed.\n'))
  process.exit(1)
}

// Clean up temp file
try { unlinkSync(TMP_JSON) } catch { /* ignore */ }

const { lines, terminal, totalFail } = buildReport(json)

// Print to terminal
terminal.forEach(l => console.log(l))

// Write log file
mkdirSync(LOGS_DIR, { recursive: true })
const logPath = join(LOGS_DIR, `test-${ts}.log`)
const header  = `Pitwall test run — ${ts}${pattern ? `\nFilter: ${pattern}` : ''}\n`
writeFileSync(logPath, header + lines.join('\n') + '\n')

console.log(DIM(`\nLog saved → ${logPath.replace(ROOT + '/', '')}\n`))

process.exit(totalFail > 0 ? 1 : 0)
