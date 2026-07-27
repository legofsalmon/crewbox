import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  apiUrl,
  certHostname,
  listRecords,
  planRecordChange,
  readResponse,
  splitHostname,
} from '../../deploy/vercel-dns.mjs'

/**
 * The updater rewrites live DNS for a whole zone with a token that can rewrite
 * every other record in it too, and it is meant to be run from cron with
 * nobody watching. So the decisions — which domain owns the name, whether to
 * create or update or leave alone — are pulled out as pure functions and
 * pinned here, because the one thing that cannot be rehearsed is a wrong
 * answer going out to every phone on site.
 *
 * Nothing here talks to Vercel. The HTTP shape is unverified until someone
 * runs it with a real token; see the note in the script's header.
 */

const dirs = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('finding the domain a hostname belongs to', () => {
  const domains = ['letissier.ie', 'example.co.uk', 'other.com']

  it('splits a subdomain off its domain', () => {
    expect(splitHostname('chat.letissier.ie', domains)).toEqual({
      domain: 'letissier.ie',
      name: 'chat',
    })
  })

  it('handles a name that is the domain itself', () => {
    // Vercel spells the apex as an empty record name, not '@'.
    expect(splitHostname('letissier.ie', domains)).toEqual({ domain: 'letissier.ie', name: '' })
  })

  it('gets a multi-part public suffix right', () => {
    // Counting dots would call the domain "co.uk" and then ask Vercel for a
    // zone that isn't ours. Asking which domains exist is what avoids that.
    expect(splitHostname('chat.example.co.uk', domains)).toEqual({
      domain: 'example.co.uk',
      name: 'chat',
    })
  })

  it('prefers the longest matching domain', () => {
    // A subdomain can be added to Vercel as a domain in its own right, and
    // then both match — the records live on the more specific one.
    expect(splitHostname('box.site.letissier.ie', ['letissier.ie', 'site.letissier.ie'])).toEqual({
      domain: 'site.letissier.ie',
      name: 'box',
    })
  })

  it('keeps deeper subdomains whole', () => {
    expect(splitHostname('a.b.letissier.ie', domains)).toEqual({
      domain: 'letissier.ie',
      name: 'a.b',
    })
  })

  it('only matches on a label boundary', () => {
    // Otherwise "notletissier.ie" would be treated as ours and the run would
    // write records into someone else's zone name.
    expect(splitHostname('notletissier.ie', domains)).toBeNull()
  })

  it('returns null when the token cannot see the domain', () => {
    expect(splitHostname('chat.somewhere.net', domains)).toBeNull()
    expect(splitHostname('chat.letissier.ie', [])).toBeNull()
  })
})

describe('deciding what to do with the record', () => {
  const a = (id, name, value) => ({ id, name, type: 'A', value })

  it('creates when nothing is there', () => {
    expect(planRecordChange([], 'chat', '192.168.1.50')).toEqual({ action: 'create' })
  })

  it('does nothing when the record already points here', () => {
    // This is the common case under cron. Rewriting an unchanged record every
    // minute is noise in the audit log and a way to find the rate limit.
    const plan = planRecordChange([a('r1', 'chat', '192.168.1.50')], 'chat', '192.168.1.50')
    expect(plan).toEqual({ action: 'none', recordId: 'r1' })
  })

  it('updates when the address has moved', () => {
    const plan = planRecordChange([a('r1', 'chat', '192.168.1.9')], 'chat', '192.168.1.50')
    expect(plan).toEqual({ action: 'update', recordId: 'r1', from: '192.168.1.9' })
  })

  it('refuses to guess between round-robin records', () => {
    // Editing one of a pair leaves crew landing on the stale one half the
    // time, which reads as "the app is broken sometimes" and is miserable to
    // diagnose in a field.
    const plan = planRecordChange(
      [a('r1', 'chat', '192.168.1.9'), a('r2', 'chat', '192.168.1.10')],
      'chat',
      '192.168.1.50'
    )
    expect(plan).toEqual({ action: 'conflict', records: ['r1', 'r2'] })
  })

  it('ignores records of other types with the same name', () => {
    // An AAAA or a TXT beside the A is normal and none of our business.
    const records = [
      { id: 'r1', name: 'chat', type: 'AAAA', value: 'fd00::1' },
      { id: 'r2', name: 'chat', type: 'TXT', value: 'hello' },
    ]
    expect(planRecordChange(records, 'chat', '192.168.1.50')).toEqual({ action: 'create' })
  })

  it('ignores records for other names', () => {
    expect(planRecordChange([a('r1', 'www', '203.0.113.1')], 'chat', '192.168.1.50')).toEqual({
      action: 'create',
    })
  })

  it('matches the apex, which Vercel may spell as a missing name', () => {
    expect(
      planRecordChange([{ id: 'r1', type: 'A', value: '203.0.113.1' }], '', '10.0.0.5')
    ).toEqual({ action: 'update', recordId: 'r1', from: '203.0.113.1' })
  })
})

describe('reading the whole zone', () => {
  it('follows pagination to the end', async () => {
    // A zone bigger than one page would otherwise look empty of our name, and
    // the run would create a second A record beside the one already there.
    const pages = [
      {
        records: [{ id: 'r1', name: 'www', type: 'A', value: '203.0.113.1' }],
        pagination: { next: 1700 },
      },
      {
        records: [{ id: 'r2', name: 'chat', type: 'A', value: '192.168.1.9' }],
        pagination: { next: null },
      },
    ]
    const seen = []
    const call = async (_method, path) => {
      seen.push(path)
      return pages.shift()
    }
    const records = await listRecords(call, 'letissier.ie')
    expect(records.map((r) => r.id)).toEqual(['r1', 'r2'])
    expect(seen[1]).toContain('until=1700')
  })

  it('stops after one page when there is no cursor', async () => {
    let calls = 0
    const call = async () => {
      calls++
      return { records: [] }
    }
    expect(await listRecords(call, 'letissier.ie')).toEqual([])
    expect(calls).toBe(1)
  })

  it('gives up rather than spinning on a cursor that never advances', async () => {
    let calls = 0
    const call = async () => {
      calls++
      return { records: [], pagination: { next: 1 } }
    }
    await listRecords(call, 'letissier.ie')
    expect(calls).toBeLessThanOrEqual(20)
  })

  it('escapes the domain into the path', async () => {
    const seen = []
    const call = async (_method, path) => {
      seen.push(path)
      return { records: [] }
    }
    await listRecords(call, 'a b.ie')
    expect(seen[0]).toContain('/v4/domains/a%20b.ie/records')
  })
})

describe('the API URL', () => {
  it('adds the team as another parameter, not a second question mark', () => {
    // `?limit=100?teamId=…` is not a URL, and Vercel answers it with a 400
    // that names neither problem.
    const url = apiUrl('/v5/domains?limit=100', 'team_abc')
    expect(url).toBe('https://api.vercel.com/v5/domains?limit=100&teamId=team_abc')
  })

  it('adds nothing on a personal account', () => {
    expect(apiUrl('/v5/domains?limit=100', undefined)).toBe(
      'https://api.vercel.com/v5/domains?limit=100'
    )
  })

  it('starts the query when the path has none', () => {
    expect(apiUrl('/v1/domains/records/rec_1', 'team_abc')).toBe(
      'https://api.vercel.com/v1/domains/records/rec_1?teamId=team_abc'
    )
  })
})

describe('reading an answer back', () => {
  const read = (status, text) => readResponse('GET', '/v5/domains', status, text)

  it('returns the data on success', () => {
    expect(read(200, '{"domains":[{"name":"letissier.ie"}]}')).toEqual({
      domains: [{ name: 'letissier.ie' }],
    })
  })

  it('accepts an empty body', () => {
    expect(read(204, '')).toEqual({})
  })

  it("repeats Vercel's own message, which names the real problem", () => {
    // "Not authorized" is worth a hundred 403s.
    expect(() => read(403, '{"error":{"message":"Not authorized"}}')).toThrow(/403: Not authorized/)
  })

  it('names a captive portal rather than dying on a JSON syntax error', () => {
    // The 200-with-a-login-page case. Parsing blind gives "Unexpected token
    // '<'" and a stack trace, which tells the person at the box nothing.
    expect(() =>
      read(200, '<html><body>Please sign in to the guest network</body></html>')
    ).toThrow(/captive portal/)
  })

  it('quotes enough of the interloper to recognise it', () => {
    expect(() => read(200, '<html>Guest WiFi portal</html>')).toThrow(/Guest WiFi portal/)
  })

  it('handles a failure whose body is not JSON either', () => {
    // A proxy 502 is HTML, and the status is the only real information.
    expect(() => read(502, '<html>Bad Gateway</html>')).toThrow(/502/)
  })
})

describe('the hostname to publish', () => {
  const certDir = (cn) => {
    const dir = mkdtempSync(join(tmpdir(), 'crewbox-vercel-'))
    dirs.push(dir)
    execFileSync(
      'openssl',
      // prettier-ignore
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', join(dir, 'key.pem'),
        '-out', join(dir, 'cert.pem'),
        '-days', '90', '-subj', `/CN=${cn}`,
      ],
      { stdio: 'ignore' }
    )
    return dir
  }

  it('is the name on the box certificate, so it matches what crew type', () => {
    expect(certHostname(certDir('chat.letissier.ie'))).toBe('chat.letissier.ie')
  })

  it('declines a wildcard certificate, which names no single host', () => {
    // "*.letissier.ie" is not something you can point an A record at.
    expect(certHostname(certDir('*.letissier.ie'))).toBeNull()
  })

  it('returns null rather than throwing on a box with no certificate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crewbox-vercel-'))
    dirs.push(dir)
    expect(certHostname(dir)).toBeNull()
    writeFileSync(join(dir, 'cert.pem'), 'not a certificate')
    expect(certHostname(dir)).toBeNull()
  })
})
