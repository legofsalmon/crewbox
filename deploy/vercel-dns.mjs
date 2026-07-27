// Point a Vercel-hosted DNS name at this box, and keep it pointed there.
//
// Usage:
//   VERCEL_TOKEN=… node deploy/vercel-dns.mjs [--hostname h] [--ip a.b.c.d] [--dry-run]
//
// Defaults: the hostname on the box's certificate, and the box's own routable
// address. Both can be overridden.
//
// WHEN THIS HELPS, AND WHEN IT DOES NOT
//
// A public DNS record can only be resolved by a device that can reach public
// DNS. On an isolated festival network — the case crewbox is built for —
// nothing can, so this does nothing and the answer is a local override on the
// router instead (Admin → This network generates one).
//
// It earns its place in the other shape: a venue network that has internet
// and hands out its own DNS, where you have no way to add a local entry. Crew
// on that network can resolve public names, so a record pointing at the box's
// address on that same network reaches it, and HTTPS works.
//
// Two things can still defeat it, and neither is visible from here:
//   - DNS rebinding protection on the venue router, which drops public
//     answers pointing into private address space. Common on consumer gear.
//   - The box's address moving, on a DHCP server you do not control. Hence
//     re-running this: it is idempotent, so cron it and it self-heals.
//
// It also publishes an internal address publicly. That is usually a shrug,
// but it is worth knowing rather than discovering.
//
// NOT YET RUN AGAINST THE LIVE API
//
// The endpoint versions below come from Vercel's documentation, and the
// decisions around them are unit-tested, but no one has yet pointed this at
// api.vercel.com with a real token. Do the first run with --dry-run, at a desk,
// with the Vercel dashboard open beside you.
//
// THE TOKEN
//
// A Vercel token can rewrite every record in the zone, so it is read from the
// environment and never written to disk by this script. Do not put it in the
// box's data directory: that directory is what deploy/backup.sh copies to a
// USB stick that lives gaffer-taped to the server.
import { X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'

const API = 'https://api.vercel.com'

/**
 * Full URL for an API path, with the team scope attached if there is one.
 *
 * Some paths carry their own query string, so the separator has to be chosen
 * rather than assumed — `?limit=100?teamId=…` is not a URL and Vercel answers
 * it with a confusing 400.
 */
export function apiUrl(path, team) {
  const url = new URL(path, API)
  if (team) url.searchParams.set('teamId', team)
  return url.toString()
}

/**
 * Which of the account's domains owns this hostname, and the record name
 * within it.
 *
 * Done by longest-suffix match against the real domain list rather than by
 * counting dots: "chat.letissier.ie" is domain + subdomain, but so is
 * "chat.example.co.uk", and no amount of splitting tells them apart without
 * either the public suffix list or — as here — asking.
 */
export function splitHostname(hostname, domains) {
  const matches = domains
    .filter((d) => hostname === d || hostname.endsWith(`.${d}`))
    .sort((a, b) => b.length - a.length)
  const domain = matches[0]
  if (!domain) return null
  return { domain, name: hostname === domain ? '' : hostname.slice(0, -(domain.length + 1)) }
}

/**
 * What to do about the A record, given what is already there.
 *
 * Deliberately returns 'none' when the value already matches: this is meant
 * to be run from cron, and a run that rewrites an unchanged record every
 * minute is both noise and a way to hit rate limits.
 */
export function planRecordChange(records, name, ip) {
  const existing = records.filter((r) => r.type === 'A' && (r.name ?? '') === name)
  if (existing.length === 0) return { action: 'create' }
  // More than one A record for the same name means round-robin, and quietly
  // editing one of them would leave crew landing on the other half the time.
  if (existing.length > 1) {
    return { action: 'conflict', records: existing.map((r) => r.id) }
  }
  const [record] = existing
  if (record.value === ip) return { action: 'none', recordId: record.id }
  return { action: 'update', recordId: record.id, from: record.value }
}

/**
 * Every DNS record in a zone, following pagination to the end.
 *
 * The page has to be exhausted rather than skimmed: a zone whose first page
 * doesn't happen to contain our name would look empty, and then this would
 * "create" a record that already exists — leaving two A records for one name
 * and crew landing on the wrong one half the time.
 */
export async function listRecords(call, domain) {
  const records = []
  let until
  // Bounded so a pagination cursor that never advances can't spin forever.
  for (let page = 0; page < 20; page++) {
    const query = new URLSearchParams({ limit: '100' })
    if (until) query.set('until', String(until))
    const data = await call('GET', `/v4/domains/${encodeURIComponent(domain)}/records?${query}`)
    records.push(...(data.records ?? []))
    until = data.pagination?.next
    if (!until) break
  }
  return records
}

/**
 * Turn a response into data, or into a sentence naming what went wrong.
 *
 * A body that isn't JSON is its own diagnosis, and a common one here: a
 * captive portal or a filtering proxy answers with a login page and a cheerful
 * 200. Parsing that blind gives a JSON syntax error and a stack trace, which
 * tells the person standing at the box nothing at all.
 */
export function readResponse(method, path, status, text) {
  let data
  try {
    data = text.trim() ? JSON.parse(text) : {}
  } catch (err) {
    const snippet = text.trim().replace(/\s+/g, ' ').slice(0, 120)
    throw new Error(
      `${method} ${path} → ${status}, but the answer was not JSON:\n` +
        `  ${snippet}\n` +
        `  Something answered for api.vercel.com — usually a captive portal wanting a\n` +
        `  login, or a filtering proxy. This one needs real internet.`,
      { cause: err }
    )
  }
  if (status >= 200 && status < 300) return data
  // Surface Vercel's own message: it names the real problem (bad token, wrong
  // team, unknown domain) far better than a status code.
  throw new Error(`${method} ${path} → ${status}: ${data?.error?.message ?? text.trim()}`)
}

/** The hostname on the box's certificate, which is the one crew will type. */
export function certHostname(dataDir) {
  try {
    const cert = new X509Certificate(readFileSync(join(dataDir, 'cert.pem'), 'utf8'))
    const cn = /CN=([^,/\n]+)/.exec(cert.subject)?.[1]?.trim()
    return cn && !cn.startsWith('*') ? cn : null
  } catch {
    return null
  }
}

export function localAddress() {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal && !addr.address.startsWith('169.254.')) {
        return addr.address
      }
    }
  }
  return null
}

// --- CLI ------------------------------------------------------------------

async function main() {
  const arg = (flag) => {
    const i = process.argv.indexOf(flag)
    const value = i === -1 ? undefined : process.argv[i + 1]
    // `--hostname --dry-run` means the value was forgotten, not that the box
    // is called "--dry-run".
    return value?.startsWith('--') ? undefined : value
  }
  const dryRun = process.argv.includes('--dry-run')
  const token = process.env.VERCEL_TOKEN
  const team = process.env.VERCEL_TEAM_ID
  const dataDir = process.env.DATA_DIR ?? join(process.env.HOME ?? '', '.crewbox', 'data')

  if (!token) {
    console.error('VERCEL_TOKEN is required (a Vercel account or team token).')
    process.exit(2)
  }

  const hostname = arg('--hostname') ?? certHostname(dataDir)
  const ip = arg('--ip') ?? localAddress()
  if (!hostname) {
    console.error(
      `No hostname: pass --hostname, or give the box a certificate in ${dataDir} to read it from.`
    )
    process.exit(2)
  }
  if (!ip) {
    console.error('No routable address on this machine to point the record at.')
    process.exit(2)
  }

  const call = async (method, path, body) => {
    let res
    try {
      res = await fetch(apiUrl(path, team), {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    } catch (err) {
      throw new Error(
        `${method} ${path} → could not reach api.vercel.com: ${err.message}\n` +
          `  This one needs internet. On site there will not be any — run it from the\n` +
          `  office, or put the entry on the venue router instead (Admin → This network).`,
        { cause: err }
      )
    }
    return readResponse(method, path, res.status, await res.text())
  }

  // Ask which domains the token can see, rather than guessing where the
  // registrable name ends.
  const { domains } = await call('GET', '/v5/domains?limit=100')
  const split = splitHostname(
    hostname,
    domains.map((d) => d.name)
  )
  if (!split) {
    console.error(
      `${hostname} is not under any domain this token can see.\n` +
        `  Visible: ${domains.map((d) => d.name).join(', ') || '(none)'}`
    )
    process.exit(1)
  }

  const records = await listRecords(call, split.domain)
  const plan = planRecordChange(records, split.name, ip)

  const label = `${hostname} → ${ip}`
  if (plan.action === 'none') {
    console.log(`already correct: ${label}`)
    process.exit(0)
  }
  if (plan.action === 'conflict') {
    console.error(
      `${split.name || '@'} has ${plan.records.length} A records on ${split.domain}.\n` +
        `  Refusing to guess which one crew should follow — remove the extras in the Vercel\n` +
        `  dashboard, then run this again.`
    )
    process.exit(1)
  }
  if (dryRun) {
    console.log(`would ${plan.action}: ${label}${plan.from ? ` (was ${plan.from})` : ''}`)
    process.exit(0)
  }

  if (plan.action === 'create') {
    await call('POST', `/v2/domains/${encodeURIComponent(split.domain)}/records`, {
      name: split.name,
      type: 'A',
      value: ip,
      // Short, because the whole point is that it can move. 60 is Vercel's
      // floor.
      ttl: 60,
    })
    console.log(`created: ${label}`)
  } else {
    await call('PATCH', `/v1/domains/records/${encodeURIComponent(plan.recordId)}`, {
      value: ip,
      ttl: 60,
    })
    console.log(`updated: ${label} (was ${plan.from})`)
  }

  console.log('')
  console.log('Check from a phone on the venue network:')
  console.log(`  the join page should load at https://${hostname} with no certificate warning.`)
  console.log('If it does not resolve, the venue router is very likely dropping a public')
  console.log('answer that points into private address space (DNS rebinding protection).')
}

if (process.argv[1]?.endsWith('vercel-dns.mjs')) {
  // A stack trace helps nobody standing at a box in a field. The messages
  // above are written to be read on their own.
  await main().catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}
