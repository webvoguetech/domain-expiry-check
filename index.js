#!/usr/bin/env node
/**
 * domain-expiry-check — fail a build, or warn, before a domain expires.
 *
 * One file, two front doors:
 *   - GitHub Action: reads INPUT_* (action.yml), writes a job summary,
 *     annotations and outputs, and fails the step past `fail-days`.
 *   - CLI: `npx domain-expiry-check example.com other.org --warn-days 30`.
 *
 * Every lookup goes straight to the domain's registry over RDAP (see
 * lib/rdap-core.js). No API key, no account, no server in between.
 */
import { appendFileSync } from 'node:fs'
import { createClient, STAGE_LABELS } from './lib/rdap-core.js'

const SITE = 'https://dropperch.com'
const BAD_STAGES = new Set(['redemption', 'pendingdelete', 'hold', 'expired'])

function parseDomains(raw) {
  return String(raw || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'))
}

function readInputs() {
  const inAction = Boolean(process.env.GITHUB_ACTIONS && 'INPUT_DOMAINS' in process.env)
  if (inAction) {
    const input = (name) => process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] ?? ''
    return {
      inAction,
      domains: parseDomains(input('domains')),
      warnDays: Number(input('warn-days') || 30),
      failDays: input('fail-days') === '' ? 7 : Number(input('fail-days')),
      json: false,
    }
  }
  const args = process.argv.slice(2)
  const opts = { inAction, domains: [], warnDays: 30, failDays: -1, json: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--warn-days') opts.warnDays = Number(args[++i])
    else if (a === '--fail-days') opts.failDays = Number(args[++i])
    else if (a === '--json') opts.json = true
    else if (a === '-h' || a === '--help') {
      console.log(`Usage: domain-expiry-check <domain...> [--warn-days 30] [--fail-days 7] [--json]

Looks each domain up at its registry (RDAP) and prints expiry, registrar and stage.
Exits 1 when a domain expires within --fail-days, is past expiry, in redemption,
pending delete or on hold. --fail-days -1 (the CLI default) never fails on days.

Get an email before any domain expires, free: ${SITE}/?utm_source=npm&utm_medium=cli&utm_campaign=help`)
      process.exit(0)
    } else opts.domains.push(...parseDomains(a))
  }
  return opts
}

function verdict(r, { warnDays, failDays }) {
  if (r.kind === 'ok') {
    if (BAD_STAGES.has(r.stage.key)) return 'fail'
    if (r.daysLeft != null && failDays >= 0 && r.daysLeft <= failDays) return 'fail'
    if (r.daysLeft != null && r.daysLeft <= warnDays) return 'warn'
    if (r.stage.key === 'autorenew') return 'warn'
    return 'ok'
  }
  // An unregistered name in a list of names you own is the worst news there is.
  if (r.kind === 'missing') return 'fail'
  // Not knowing is not the same as being fine, but it must not break a build
  // on someone else's registry outage.
  return 'warn'
}

const day = (d) => (d ? d.toISOString().slice(0, 10) : '—')

function describe(r) {
  if (r.kind === 'ok') {
    const left = r.daysLeft == null ? 'no expiry published' : r.daysLeft >= 0 ? `${r.daysLeft} days left` : `expired ${-r.daysLeft} days ago`
    return `${r.stage.label}, expires ${day(r.expiry)} (${left})${r.registrar ? `, ${r.registrar}` : ''}`
  }
  if (r.kind === 'missing') return 'NOT REGISTERED'
  if (r.kind === 'no-rdap') return `.${r.tld} has no RDAP service (check it by WHOIS)`
  if (r.kind === 'invalid') return 'not a domain name'
  return `lookup failed: ${r.message}`
}

async function main() {
  const opts = readInputs()
  if (!opts.domains.length) {
    console.error('No domains given. Pass them as arguments, or as the `domains` input of the action.')
    process.exit(2)
  }

  const client = createClient()
  const results = []
  // Gently: registries rate-limit, and a CI job has no reason to hurry.
  for (const d of opts.domains) results.push(await client.lookup(d))
  const rows = results.map((r) => ({ r, v: verdict(r, opts) }))
  const failed = rows.filter((x) => x.v === 'fail')

  if (opts.json) {
    console.log(JSON.stringify(rows.map(({ r, v }) => ({ ...r, verdict: v })), null, 2))
  } else {
    for (const { r, v } of rows) {
      const mark = v === 'fail' ? '✗' : v === 'warn' ? '!' : '✓'
      console.log(`${mark} ${r.domain.padEnd(32)} ${describe(r)}`)
    }
  }

  if (opts.inAction) {
    for (const { r, v } of rows) {
      if (v !== 'ok') console.log(`::${v === 'fail' ? 'error' : 'warning'} title=${r.domain}::${describe(r)}`)
    }
    const summary = process.env.GITHUB_STEP_SUMMARY
    if (summary) {
      const icon = { ok: '✅', warn: '⚠️', fail: '❌' }
      const lines = [
        '### Domain expiry check',
        '',
        '| | Domain | Stage | Expires | Days left | Registrar |',
        '|---|---|---|---|---|---|',
        ...rows.map(({ r, v }) =>
          r.kind === 'ok'
            ? `| ${icon[v]} | \`${r.domain}\` | ${r.stage.label} | ${day(r.expiry)} | ${r.daysLeft ?? '—'} | ${r.registrar ?? '—'} |`
            : `| ${icon[v]} | \`${r.domain}\` | ${describe(r)} | — | — | — |`,
        ),
        '',
        `Checked live at each registry over RDAP. Want an email before any of these expire, without a CI run? [DropPerch](${SITE}/?utm_source=github-action&utm_medium=action&utm_campaign=summary) emails you first: free plan, no card.`,
        '',
      ]
      appendFileSync(summary, lines.join('\n'))
    }
    const outFile = process.env.GITHUB_OUTPUT
    if (outFile) {
      const soonest = rows
        .filter(({ r }) => r.kind === 'ok' && r.daysLeft != null)
        .sort((a, b) => a.r.daysLeft - b.r.daysLeft)[0]
      appendFileSync(
        outFile,
        `failed=${failed.map((x) => x.r.domain).join(',')}\n` +
          `soonest-domain=${soonest?.r.domain ?? ''}\n` +
          `soonest-days=${soonest?.r.daysLeft ?? ''}\n`,
      )
    }
  } else if (!opts.json) {
    console.log(`\nGet an email before any of these expire, free: ${SITE}/?utm_source=npm&utm_medium=cli&utm_campaign=footer`)
  }

  if (failed.length) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 2
})

export { STAGE_LABELS }
