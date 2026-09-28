import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  MAX_MANIFESTS,
  MAX_PAGES,
  PAGE_SIZE,
  READ_BUDGET_MS,
  findingLines,
  pickRegistry,
  readFailure,
  readRegistry,
  registrySummary,
  type HttpGet,
  type HttpResponse,
} from '../src/audit/nmos.ts'
import type { MediaService, NmosService } from '../src/netwatch/mdns.ts'
import type { RegistryReport } from '@crewbox/st2110'

/**
 * Reading a registry the way the deep probe does, against a registry made of
 * answers: what is asked for, in what order, and what is made of the replies.
 * The facility is legofsalmon/st2110's own test registry (two nodes, a camera
 * and a monitor), so the same snapshot its checks are tested on.
 */

const FACILITY = JSON.parse(
  readFileSync(new URL('./fixtures/nmos-facility.json', import.meta.url), 'utf8')
) as Record<string, unknown>

const BASE = 'http://10.20.0.5:8080/x-nmos/query/v1.3/'
const KINDS = ['nodes', 'devices', 'sources', 'flows', 'senders', 'receivers']

const ok = (value: unknown, headers: Record<string, string> = {}): HttpResponse => ({
  status: 200,
  headers,
  body: typeof value === 'string' ? value : JSON.stringify(value),
})

/** A registry that answers from the facility, and records what it was asked. */
function registry(answer?: (url: string) => HttpResponse | undefined) {
  const asked: string[] = []
  const get: HttpGet = async (url) => {
    asked.push(url)
    const special = answer?.(url)
    if (special) return special
    if (url === 'http://10.20.0.5:8080/x-nmos/query/') return ok(['v1.2/', 'v1.3/'])
    for (const kind of KINDS) {
      if (url.startsWith(`${BASE}${kind}/`)) return ok(FACILITY[kind])
    }
    const manifests = FACILITY.manifests as Record<string, { url: string; sdp: string }>
    const manifest = Object.values(manifests).find((m) => m.url === url)
    if (manifest) return ok(manifest.sdp)
    return { status: 404, headers: {}, body: '' }
  }
  return { get, asked }
}

describe('reading a registry', () => {
  it('asks the root for its versions, reads every list, then each SDP file', async () => {
    const { get, asked } = registry()
    const read = await readRegistry('http://10.20.0.5:8080', get)
    expect(read.base).toBe(BASE)
    expect(read.snapshot.api_version).toBe('v1.3')
    expect(read.snapshot.senders).toHaveLength(2)
    expect(Object.keys(read.snapshot.manifests ?? {})).toHaveLength(2)
    expect(read.requests).toEqual({ registry: 7, manifests: 2, hosts: 1 })
    expect(read.partial).toEqual([])
    expect(asked[0]).toBe('http://10.20.0.5:8080/x-nmos/query/')
    expect(asked[1]).toBe(
      `${BASE}nodes/?paging.order=create&paging.since=0:0&paging.limit=${PAGE_SIZE}`
    )
  })

  it('takes a URL naming a version as it is', async () => {
    const { get, asked } = registry()
    await readRegistry(BASE, get)
    expect(asked[0]).toMatch(/^http:\/\/10\.20\.0\.5:8080\/x-nmos\/query\/v1\.3\/nodes\//)
  })

  it('pages in creation order until the cursor stops, and keeps each resource once', async () => {
    const node = (n: number) => ({ id: `node-${n}`, label: `Node ${n}` })
    const pages: Record<string, { items: unknown[]; until: string }> = {
      '0:0': { items: [node(1), node(2)], until: '2:0' },
      '2:0': { items: [node(2), node(3)], until: '3:0' },
      '3:0': { items: [], until: '3:0' },
    }
    const { get } = registry((url) => {
      if (!url.startsWith(`${BASE}nodes/`)) return undefined
      const since = /paging\.since=([^&]+)/.exec(url)![1]!
      const page = pages[since]!
      return ok(page.items, { 'x-paging-limit': '100', 'x-paging-until': page.until })
    })
    const read = await readRegistry(BASE, get)
    expect((read.snapshot.nodes as Array<{ id: string }>).map((n) => n.id)).toEqual([
      'node-1',
      'node-2',
      'node-3',
    ])
  })

  it('asks again without paging when the registry does not implement it', async () => {
    const { get, asked } = registry((url) =>
      url.includes('paging.') ? { status: 501, headers: {}, body: '' } : undefined
    )
    const read = await readRegistry(BASE, get)
    expect(read.snapshot.nodes).toHaveLength(2)
    expect(asked).toContain(`${BASE}nodes/`)
  })

  it('never pages an IS-04 v1.0 registry, which has no paging', async () => {
    const v10 = 'http://10.20.0.5:8080/x-nmos/query/v1.0/'
    const { get, asked } = registry((url) => (url.startsWith(v10) ? ok([]) : undefined))
    await readRegistry(v10, get)
    expect(asked.every((url) => !url.includes('paging.'))).toBe(true)
  })

  it('stops at a bound on pages, and says what was left unread', async () => {
    let n = 0
    const { get } = registry((url) => {
      if (!url.startsWith(`${BASE}flows/`)) return undefined
      n++
      return ok([{ id: `flow-${n}` }], { 'x-paging-limit': '1', 'x-paging-until': `${n}:0` })
    })
    const read = await readRegistry(BASE, get)
    expect(read.snapshot.flows).toHaveLength(MAX_PAGES)
    expect(read.partial).toEqual([`flows past the first ${MAX_PAGES * PAGE_SIZE}`])
  })

  it('records an SDP file it could not fetch, for the checks to report', async () => {
    const { get } = registry((url) => {
      if (url.includes('/senders/5e0d0001')) throw new Error('connect ECONNREFUSED')
      if (url.includes('/senders/5e0d0002')) return { status: 404, headers: {}, body: '' }
      return undefined
    })
    const read = await readRegistry(BASE, get)
    const manifests = Object.values(read.snapshot.manifests ?? {})
    expect(manifests.map((m) => m.error ?? m.status)).toEqual(
      expect.arrayContaining(['connect ECONNREFUSED', 404])
    )
  })

  it('fetches only so many SDP files, and only while there is time', async () => {
    const senders = Array.from({ length: MAX_MANIFESTS + 5 }, (_, i) => ({
      id: `s-${i}`,
      transport: 'urn:x-nmos:transport:rtp.mcast',
      manifest_href: `http://10.20.1.${i % 250}/sdp/${i}`,
    }))
    const { get } = registry((url) =>
      url.startsWith(`${BASE}senders/`)
        ? ok(senders)
        : url.includes('/sdp/')
          ? ok('v=0')
          : undefined
    )
    const read = await readRegistry(BASE, get)
    expect(read.requests.manifests).toBe(MAX_MANIFESTS)
    expect(read.partial).toEqual([`the SDP files of 5 senders past the first ${MAX_MANIFESTS}`])

    let clock = 0
    const slow = registry((url) => {
      if (url.startsWith(`${BASE}senders/`)) return ok(senders.slice(0, 20))
      if (url.includes('/sdp/')) {
        clock += READ_BUDGET_MS / 10
        return ok('v=0')
      }
      return undefined
    })
    const late = await readRegistry(BASE, slow.get, () => clock)
    expect(late.requests.manifests).toBeLessThan(20)
    expect(late.partial[0]).toMatch(/past the 30 s the read may take/)
  })

  it('refuses what is not a Query API, in words the probe can show', async () => {
    const cases: Array<[string, HttpGet]> = [
      ['ftp://10.20.0.5', registry().get],
      ['http://10.20.0.5:8080/x-nmos/query/v2.0', registry().get],
      ['http://10.20.0.5:8080', registry(() => ({ status: 404, headers: {}, body: '' })).get],
      ['http://10.20.0.5:8080', registry(() => ok(['v2.0/'])).get],
      [
        BASE,
        registry((url) =>
          url.startsWith(`${BASE}devices/`) ? ok('<html>not json</html>') : undefined
        ).get,
      ],
      [
        BASE,
        async () => {
          throw new Error('connect EHOSTUNREACH')
        },
      ],
    ]
    for (const [url, get] of cases) {
      const failure = await readRegistry(url, get).then(
        () => null,
        (err: unknown) => readFailure(err)
      )
      expect(failure, url).toEqual(expect.any(String))
    }
    // A bug is not a read failure, and is not dressed up as one.
    expect(readFailure(new TypeError('x'))).toBeNull()
  })
})

describe('choosing the registry', () => {
  const service = (over: Partial<MediaService>, nmos: Partial<NmosService> = {}): MediaService => ({
    name: 'registry',
    kind: 'nmos',
    address: '10.20.0.5',
    firstSeen: 0,
    lastSeen: 0,
    saidGoodbye: false,
    nmos: {
      api: 'query',
      port: 8080,
      proto: 'http',
      versions: ['v1.2', 'v1.3'],
      priority: 0,
      ...nmos,
    },
    ...over,
  })

  it('takes the one Box settings names over any that announced itself', () => {
    expect(pickRegistry(' http://reg.example:80 ', [service({})])).toEqual({
      url: 'http://reg.example:80',
      from: 'setting',
    })
  })

  it('takes the preferred Query API, at the newest version it serves', () => {
    const picked = pickRegistry('', [
      service({ address: '10.20.0.9' }, { priority: 100 }),
      service({ address: '10.20.0.6' }, { priority: 10, proto: 'https', versions: ['v1.2'] }),
      service({ address: '10.20.0.7' }, { api: 'registration', priority: 0 }),
      service({ address: '10.20.0.8', saidGoodbye: true }, { priority: 0 }),
      service({ address: '' }, { priority: 0 }),
    ])
    expect(picked).toEqual({ url: 'https://10.20.0.6:8080/x-nmos/query/v1.2/', from: 'mdns' })
    expect(pickRegistry('', [service({}, { versions: [] })])?.url).toBe(
      'http://10.20.0.5:8080/x-nmos/query/'
    )
    expect(pickRegistry('', [])).toBeNull()
  })
})

describe("what the probe says of a registry's report", () => {
  const report = (over: Partial<RegistryReport> = {}): RegistryReport =>
    ({
      source: BASE,
      api_version: 'v1.3',
      summary: {
        nodes: 2,
        devices: 2,
        sources: 2,
        flows: 2,
        senders: 2,
        receivers: 1,
        active_senders: 2,
        active_receivers: 1,
        grandmasters: [{ id: '08-00-11-ff-fe-21-e1-b0', clocks: 2 }],
        unlocked_clocks: 0,
      },
      senders: [],
      receivers: [],
      findings: [],
      ...over,
    }) as RegistryReport

  it('counts what is registered, and whose clock it follows', () => {
    expect(registrySummary(report())).toBe(
      '2 nodes, 2 senders (2 active), 1 receiver (1 taking a stream). ' +
        'Every registered clock follows grandmaster 08-00-11-ff-fe-21-e1-b0.'
    )
    const split = report()
    split.summary.grandmasters.push({ id: '00-1d-c1-ff-fe-00-00-01', clocks: 1 })
    expect(registrySummary(split)).toContain('follow 2 different grandmasters')
  })

  it('lists faults before warnings, with where each is, and leaves notes out', () => {
    const finding = (
      severity: 'error' | 'warning' | 'info',
      message: string,
      line: number | null = null
    ) => ({
      rule: 'r',
      severity,
      message,
      reference: '',
      resource: { kind: 'sender' as const, id: 's', label: 'CAM 1 video', index: 0 },
      line,
    })
    const lines = findingLines(
      report({
        findings: [
          finding('warning', 'w'),
          finding('info', 'i'),
          finding('error', 'no a=ts-refclk', 5),
        ],
      })
    )
    expect(lines).toEqual([
      'Fault: CAM 1 video (sender): no a=ts-refclk (SDP line 5)',
      'Warning: CAM 1 video (sender): w',
    ])
    const many = findingLines(
      report({ findings: Array.from({ length: 60 }, () => finding('error', 'x')) }),
      50
    )
    expect(many).toHaveLength(51)
    expect(many[50]).toBe('…and 10 more.')
  })
})
