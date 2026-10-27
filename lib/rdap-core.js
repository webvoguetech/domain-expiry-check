/**
 * Domain lookups straight from the registry, over RDAP, with no server.
 *
 * Shared by the DropPerch browser extension and the domain-expiry-check
 * GitHub Action / CLI. It is the DOM-free core of scripts/tools/lookup-client.js
 * (the website's checkers), kept to the same rules so all three give the same
 * answer for the same domain:
 *
 *   - the IANA bootstrap file (CORS-open) names the authoritative RDAP server
 *     per TLD, so every lookup goes straight to the registry, never through a
 *     DropPerch server or a cached WHOIS mirror;
 *   - a 404 on a three-label name is retried on its parent (firebase.google.com
 *     is not registered, google.com is);
 *   - status codes beat dates when deciding the lifecycle stage;
 *   - drop dates use ICANN's grace/redemption timings and Verisign's observed
 *     six days from pendingDelete to release (see lookup-client.js PD_TO_DROP).
 *
 * Dependency-free ES module. Pass `fetch` in to test it without a network.
 */

const BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json'
const FALLBACK_BASE = 'https://rdap.org/'
const DAY = 86400000
export const GRACE_MAX = 45
export const REDEMPTION = 30
export const PD_TO_DROP = 6

/** "https://www.Example.com/path" -> "example.com"; '' when nothing usable. */
export function normaliseDomain(raw) {
  let s = String(raw || '').trim().toLowerCase()
  if (!s) return ''
  if (s.includes('@')) s = s.slice(s.lastIndexOf('@') + 1)
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  s = s.split('/')[0].split('?')[0].split('#')[0].split(':')[0]
  s = s.replace(/\.+$/, '')
  if (s.startsWith('www.')) s = s.slice(4)
  return s
}

/** A name worth sending to a registry. Deliberately permissive. */
export function looksLikeDomain(d) {
  return /^[a-z0-9¡-￿]([a-z0-9¡-￿-]*[a-z0-9¡-￿])?(\.[a-z0-9¡-￿-]+)+$/.test(d)
}

const utcDay = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
const addDays = (d, n) => new Date(utcDay(d) + n * DAY)

/** Whole days from `now` to `date`, in UTC so a timezone cannot shift it. */
export function daysUntil(date, now = new Date()) {
  return Math.round((utcDay(date) - utcDay(now)) / DAY)
}

function eventDate(body, action) {
  for (const e of body?.events ?? []) {
    if (e?.eventAction === action && e.eventDate) {
      const d = new Date(e.eventDate)
      if (!Number.isNaN(d.getTime())) return d
    }
  }
  return null
}

/** Registrar name out of the jCard: ["fn", {}, "text", "Dynadot Inc"]. */
function registrarOf(body) {
  for (const e of body?.entities ?? []) {
    if (!(e?.roles ?? []).includes('registrar')) continue
    for (const f of e.vcardArray?.[1] ?? []) {
      if (f?.[0] === 'fn' && typeof f[3] === 'string' && f[3].trim()) return f[3].trim()
    }
  }
  return null
}

function nameserversOf(body) {
  const out = new Set()
  for (const ns of body?.nameservers ?? []) {
    const h = String(ns?.ldhName ?? '').toLowerCase().trim().replace(/\.+$/, '')
    if (h) out.add(h)
  }
  return [...out].sort()
}

/**
 * Lifecycle stage. key: pendingdelete | redemption | hold | autorenew |
 * expired | soon | active | registered. tone: crit | warn | ok.
 */
export function lifecycle(codes, expiry, now = new Date()) {
  const has = (c) => codes.includes(c)
  if (has('pendingdelete')) return { key: 'pendingdelete', tone: 'crit' }
  if (has('redemptionperiod')) return { key: 'redemption', tone: 'crit' }
  if (has('clienthold') || has('serverhold')) return { key: 'hold', tone: 'crit' }
  if (has('autorenewperiod')) return { key: 'autorenew', tone: 'warn' }
  if (expiry) {
    const d = daysUntil(expiry, now)
    if (d < 0) return { key: 'expired', tone: 'crit' }
    if (d <= 30) return { key: 'soon', tone: 'warn' }
    return { key: 'active', tone: 'ok' }
  }
  return { key: 'registered', tone: 'ok' }
}

export const STAGE_LABELS = {
  pendingdelete: 'Pending delete',
  redemption: 'Redemption period',
  hold: 'On hold',
  autorenew: 'Auto-renew grace',
  expired: 'Expired',
  soon: 'Expires soon',
  active: 'Active',
  registered: 'Registered',
}

/**
 * When the domain would be released. Returns one of:
 *   { kind: 'cctld' }                      no ICANN timeline to apply
 *   { kind: 'exact', date, restorableUntil? }
 *   { kind: 'window', earliest, latest, ifNotRenewed }
 *   { kind: 'unknown' }
 */
export function dropEstimate(domain, stage, expiry, changed, now = new Date()) {
  const tld = domain.split('.').pop()
  if (/^[a-z]{2}$/.test(tld)) return { kind: 'cctld' }
  const ago = changed ? -daysUntil(changed, now) : null

  if (stage.key === 'pendingdelete') {
    if (ago != null && ago >= 0 && ago <= PD_TO_DROP) {
      return { kind: 'exact', date: addDays(changed, PD_TO_DROP) }
    }
    return { kind: 'window', earliest: addDays(now, 0), latest: addDays(now, PD_TO_DROP), ifNotRenewed: false }
  }
  if (stage.key === 'redemption') {
    if (ago != null && ago >= 0 && ago <= REDEMPTION) {
      return {
        kind: 'exact',
        date: addDays(changed, REDEMPTION + PD_TO_DROP),
        restorableUntil: addDays(changed, REDEMPTION),
      }
    }
    return {
      kind: 'window',
      earliest: addDays(now, PD_TO_DROP),
      latest: addDays(now, REDEMPTION + PD_TO_DROP),
      ifNotRenewed: false,
    }
  }
  if (!expiry) return { kind: 'unknown' }
  const tail = REDEMPTION + PD_TO_DROP
  if (daysUntil(expiry, now) >= 0) {
    return {
      kind: 'window',
      earliest: addDays(expiry, tail),
      latest: addDays(expiry, GRACE_MAX + tail),
      ifNotRenewed: true,
    }
  }
  let latest = addDays(expiry, GRACE_MAX + tail)
  if (latest < addDays(now, tail)) latest = addDays(now, tail)
  return { kind: 'window', earliest: addDays(now, tail), latest, ifNotRenewed: false }
}

/** Calendar age, e.g. { years: 31, months: 9, days: 11344 }. */
export function ageOf(from, now = new Date()) {
  let years = now.getUTCFullYear() - from.getUTCFullYear()
  let months = now.getUTCMonth() - from.getUTCMonth()
  if (now.getUTCDate() < from.getUTCDate()) months--
  if (months < 0) {
    years--
    months += 12
  }
  return { years: Math.max(0, years), months: Math.max(0, months), days: Math.max(0, -daysUntil(from, now)) }
}

/** Reduce an RDAP domain response to the facts people check for. */
export function summarise(domain, body, now = new Date()) {
  const codes = (body?.status ?? []).map((s) => String(s).toLowerCase().replace(/[\s_-]/g, ''))
  const expiry = eventDate(body, 'expiration')
  const registered = eventDate(body, 'registration')
  const changed = eventDate(body, 'last changed')
  const stage = lifecycle(codes, expiry, now)
  return {
    domain,
    kind: 'ok',
    stage: { ...stage, label: STAGE_LABELS[stage.key] },
    expiry,
    daysLeft: expiry ? daysUntil(expiry, now) : null,
    registered,
    age: registered ? ageOf(registered, now) : null,
    lastChanged: changed,
    registrar: registrarOf(body),
    nameservers: nameserversOf(body),
    status: (body?.status ?? []).map(String),
    drop: dropEstimate(domain, stage, expiry, changed, now),
  }
}

/**
 * A client with its own bootstrap cache. One per process is plenty.
 *
 * @param {{fetch?: typeof fetch, retryDelayMs?: number, timeoutMs?: number}} [opts]
 */
export function createClient({ fetch: raw = globalThis.fetch, retryDelayMs = 2500, timeoutMs = 12000 } = {}) {
  let bootstrapPromise = null

  // A registry that never answers must become an error, not a spinner that
  // runs forever: every request gets its own deadline.
  const f = (url, init = {}) => {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    return raw(url, { ...init, signal: ac.signal }).finally(() => clearTimeout(timer))
  }

  function bootstrap() {
    bootstrapPromise ??= f(BOOTSTRAP_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`bootstrap HTTP ${res.status}`)
        return res.json()
      })
      .then((json) => {
        const map = {}
        for (const [tlds = [], urls = []] of json?.services ?? []) {
          const base = urls.find((u) => /^https:/.test(u)) ?? urls[0]
          for (const t of tlds) map[String(t).toLowerCase()] = base
        }
        return map
      })
      .catch(() => null)
    return bootstrapPromise
  }

  async function fetchRdap(name) {
    const map = await bootstrap()
    let base = FALLBACK_BASE
    if (map) {
      const labels = name.split('.')
      base = null
      for (let i = 1; i < labels.length && !base; i++) base = map[labels.slice(i).join('.')]
      if (!base) {
        const err = new Error(`no RDAP service for .${labels.at(-1)}`)
        err.noRdap = labels.at(-1)
        throw err
      }
    }
    if (!base.endsWith('/')) base += '/'
    return f(`${base}domain/${encodeURIComponent(name)}`, { headers: { Accept: 'application/rdap+json' } })
  }

  async function lookupName(domain) {
    const res = await fetchRdap(domain)
    const labels = domain.split('.')
    if (res.status !== 404 || labels.length < 3) return { res, name: domain }
    const up = await lookupName(labels.slice(1).join('.'))
    return up.res.status === 404 ? { res, name: domain } : up
  }

  /**
   * Look a domain up. Never throws.
   * kind: 'ok' | 'missing' (not registered) | 'no-rdap' | 'invalid' | 'error'.
   */
  async function lookup(raw, { now = new Date() } = {}) {
    const domain = normaliseDomain(raw)
    if (!domain || !looksLikeDomain(domain)) return { domain: domain || String(raw), kind: 'invalid' }
    let ascii = domain
    try {
      ascii = new URL(`http://${domain}`).hostname
    } catch {}

    for (let attempt = 0; ; attempt++) {
      try {
        const { res, name } = await lookupName(ascii)
        if (res.status === 404) return { domain, kind: 'missing' }
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return summarise(name, await res.json(), now)
      } catch (err) {
        if (err?.noRdap) return { domain, kind: 'no-rdap', tld: err.noRdap }
        // Rate-limited registries often answer 429 without the CORS header,
        // which reaches a browser as a bare network error: retry every
        // failure once rather than guess which kind it was.
        if (attempt >= 1) return { domain, kind: 'error', message: String(err?.message || err) }
        await new Promise((r) => setTimeout(r, retryDelayMs))
      }
    }
  }

  return { lookup }
}
