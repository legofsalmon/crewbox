import http from 'node:http'
import https from 'node:https'
import type { Manifest, RegistryReport, Snapshot } from '@crewbox/st2110'
import type { MediaService } from '../netwatch/mdns.ts'

/**
 * Reading an NMOS registry, for the deep probe.
 *
 * An NMOS registry (AMWA IS-04) is where ST 2110 kit says what it is: every
 * node, device, source, flow, sender and receiver, and for each sender a
 * link to its SDP file. The st2110 checks (checkRegistry) find what is wrong
 * there — a sender whose SDP file disagrees with its flow, a receiver
 * subscribed to a stream it cannot take, clocks locked to different
 * grandmasters. Reading it takes HTTP requests to the registry and to every
 * sender's device, so it happens only in the deep probe, when an admin
 * asks, and the probe counts every request in its `sent` line.
 *
 * The reading is the same as `st2110 nmos` does (legofsalmon/st2110,
 * crates/nmos/src/client.rs), less two things a festival rig does not need:
 * downgrade queries, for resources registered at an older IS-04 version, and
 * the Connection API's own copy of each SDP file where it differs from the
 * manifest_href.
 */

/** The IS-04 versions read, oldest first. */
export const NMOS_VERSIONS = ['v1.0', 'v1.1', 'v1.2', 'v1.3'] as const

const KINDS = ['nodes', 'devices', 'sources', 'flows', 'senders', 'receivers'] as const

export const PAGE_SIZE = 100

/**
 * Pages read of each list: 5,000 resources of a kind, far past any rig.
 * A registry past it is read in part, and the probe says so.
 */
export const MAX_PAGES = 50

/** SDP files fetched: one per sender, up to this many. */
export const MAX_MANIFESTS = 200

/** SDP files fetched at once. */
export const PARALLEL = 8

/** How long one request may take, connecting to last byte. */
export const REQUEST_TIMEOUT_MS = 3000

/** The whole read: past it, no more SDP files are asked for. */
export const READ_BUDGET_MS = 30_000

const LIST_LIMIT = 32 * 1024 * 1024
const SDP_LIMIT = 64 * 1024

export interface HttpResponse {
  status: number
  /** Header names in lower case. */
  headers: Record<string, string | undefined>
  body: string
}

export type HttpGet = (
  url: string,
  options: { accept: string; limit: number; timeoutMs: number }
) => Promise<HttpResponse>

/**
 * GET with Node's own client, leaving from `localAddress` when one is given:
 * the media network's adapter, so a request for a registry on that network
 * cannot wander out of another one.
 */
export function nodeHttpGet(localAddress?: string): HttpGet {
  return (url, { accept, limit, timeoutMs }) =>
    new Promise((resolve, reject) => {
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        reject(new Error('not a URL'))
        return
      }
      const client =
        parsed.protocol === 'http:' ? http : parsed.protocol === 'https:' ? https : null
      if (!client) {
        reject(new Error('not an http:// or https:// URL'))
        return
      }
      const request = client.get(
        parsed,
        {
          headers: { accept, 'cache-control': 'no-cache', 'user-agent': 'crewbox' },
          ...(localAddress ? { localAddress } : {}),
        },
        (response) => {
          const chunks: Buffer[] = []
          let size = 0
          response.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > limit) request.destroy(new Error(`the answer is over ${limit} bytes`))
            else chunks.push(chunk)
          })
          response.on('end', () => {
            clearTimeout(timer)
            const headers: Record<string, string | undefined> = {}
            for (const [name, value] of Object.entries(response.headers)) {
              headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value
            }
            resolve({
              status: response.statusCode ?? 0,
              headers,
              body: Buffer.concat(chunks).toString('utf8'),
            })
          })
          response.on('error', reject)
        }
      )
      const timer = setTimeout(
        () => request.destroy(new Error(`no answer within ${timeoutMs / 1000} s`)),
        timeoutMs
      )
      request.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
}

export interface RegistryTarget {
  url: string
  /** Box settings named it, or it announced itself over mDNS. */
  from: 'setting' | 'mdns'
}

/**
 * The registry to read: the one Box settings names, else the preferred Query
 * API the mDNS roster holds (IS-04 §3.1: lowest `pri` first; 100 and above
 * are for testing, and taken only when nothing else is there).
 */
export function pickRegistry(
  configured: string | undefined,
  roster: MediaService[]
): RegistryTarget | null {
  if (configured?.trim()) return { url: configured.trim(), from: 'setting' }
  const best = roster
    .filter((s) => s.nmos?.api === 'query' && !s.saidGoodbye && s.address && s.nmos.port)
    .sort(
      (a, b) => (a.nmos?.priority ?? 99) - (b.nmos?.priority ?? 99) || b.lastSeen - a.lastSeen
    )[0]
  if (!best?.nmos) return null
  const version = [...NMOS_VERSIONS].reverse().find((v) => best.nmos?.versions.includes(v))
  const url = `${best.nmos.proto}://${best.address}:${best.nmos.port}/x-nmos/query/`
  return { url: version ? `${url}${version}/` : url, from: 'mdns' }
}

export interface RegistryRead {
  snapshot: Snapshot
  /** The versioned Query API read, ending in `/`. */
  base: string
  /** Requests made, for the probe's `sent` line. */
  requests: { registry: number; manifests: number; hosts: number }
  /** What was left unread: a list cut short, SDP files not asked for. */
  partial: string[]
}

class ReadError extends Error {}

/**
 * Read a registry: every resource, then each RTP sender's SDP file. Throws
 * when the registry itself cannot be read; an SDP file that cannot be
 * fetched is recorded in the snapshot, which the checks report on.
 */
export async function readRegistry(
  url: string,
  get: HttpGet,
  now: () => number = Date.now
): Promise<RegistryRead> {
  const started = now()
  const requests = { registry: 0, manifests: 0, hosts: 0 }
  const partial: string[] = []
  const json = async (target: string): Promise<{ response: HttpResponse; value: unknown }> => {
    requests.registry++
    let response: HttpResponse
    try {
      response = await get(target, {
        accept: 'application/json',
        limit: LIST_LIMIT,
        timeoutMs: REQUEST_TIMEOUT_MS,
      })
    } catch (err) {
      throw new ReadError(`${target}: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (response.status !== 200) return { response, value: null }
    try {
      return { response, value: JSON.parse(response.body) as unknown }
    } catch {
      throw new ReadError(`${target}: the answer is not JSON`)
    }
  }

  // The API's root lists its versions, unless the URL names one already.
  const trimmed = url.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(trimmed))
    throw new ReadError(`${url} is not an http:// or https:// URL`)
  let base: string
  let version: string
  const named = /\/x-nmos\/query\/(v\d+\.\d+)$/.exec(trimmed)
  if (named) {
    if (!(NMOS_VERSIONS as readonly string[]).includes(named[1]!)) {
      throw new ReadError(`${named[1]} is not an IS-04 version crewbox reads (v1.0 to v1.3)`)
    }
    version = named[1]!
    base = `${trimmed}/`
  } else {
    const root = trimmed.endsWith('/x-nmos/query') ? `${trimmed}/` : `${trimmed}/x-nmos/query/`
    const { response, value } = await json(root)
    if (response.status !== 200) {
      throw new ReadError(`${root}: HTTP ${response.status}, so no IS-04 Query API is there`)
    }
    const offered = Array.isArray(value) ? value.map((v) => String(v).replace(/\/$/, '')) : []
    const newest = [...NMOS_VERSIONS].reverse().find((v) => offered.includes(v))
    if (!newest) {
      throw new ReadError(
        `${root} offers ${offered.join(', ') || 'no versions'}, none of v1.0 to v1.3`
      )
    }
    version = newest
    base = `${root}${newest}/`
  }

  const snapshot: Snapshot = { source: base, api_version: version }
  for (const kind of KINDS) {
    snapshot[kind] = await readList(`${base}${kind}/`, version, json, partial)
  }

  // Each RTP sender's SDP file, from its manifest_href.
  const senders = (snapshot.senders ?? []) as Array<Record<string, unknown>>
  const wanted = senders.flatMap((s) => {
    const id = typeof s.id === 'string' ? s.id : null
    const href = typeof s.manifest_href === 'string' ? s.manifest_href : null
    const rtp =
      typeof s.transport === 'string' && s.transport.startsWith('urn:x-nmos:transport:rtp')
    return id && href && rtp && /^https?:\/\//i.test(href) ? [{ id, href }] : []
  })
  if (wanted.length > MAX_MANIFESTS) {
    partial.push(
      `the SDP files of ${wanted.length - MAX_MANIFESTS} senders past the first ${MAX_MANIFESTS}`
    )
  }
  const manifests: Record<string, Manifest> = {}
  const hosts = new Set<string>()
  const queue = wanted.slice(0, MAX_MANIFESTS)
  let skipped = 0
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      if (now() - started > READ_BUDGET_MS) {
        skipped++
        continue
      }
      requests.manifests++
      hosts.add(new URL(next.href).host)
      try {
        const response = await get(next.href, {
          accept: 'application/sdp, text/plain;q=0.9, */*;q=0.8',
          limit: SDP_LIMIT,
          timeoutMs: REQUEST_TIMEOUT_MS,
        })
        manifests[next.id] =
          response.status >= 200 && response.status < 300
            ? { url: next.href, status: response.status, sdp: response.body }
            : { url: next.href, status: response.status }
      } catch (err) {
        manifests[next.id] = {
          url: next.href,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker))
  if (skipped > 0) {
    partial.push(
      `the SDP files of ${skipped} senders, past the ${READ_BUDGET_MS / 1000} s the read may take`
    )
  }
  snapshot.manifests = manifests
  requests.hosts = hosts.size
  return { snapshot, base, requests, partial }
}

/**
 * One collection, paged in creation order where the registry pages
 * (IS-04 v1.1 and on). A registry that answers 501 to paging does not
 * implement it, and is asked again without.
 */
async function readList(
  collection: string,
  version: string,
  json: (url: string) => Promise<{ response: HttpResponse; value: unknown }>,
  partial: string[]
): Promise<object[]> {
  const resources: object[] = []
  const seen = new Set<string>()
  let paging = version !== 'v1.0'
  let since = '0:0'
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = paging
      ? `${collection}?paging.order=create&paging.since=${since}&paging.limit=${PAGE_SIZE}`
      : collection
    const { response, value } = await json(url)
    if (response.status === 501 && paging && resources.length === 0) {
      paging = false
      page--
      continue
    }
    if (response.status !== 200) throw new ReadError(`${url}: HTTP ${response.status}`)
    if (!Array.isArray(value)) throw new ReadError(`${url}: expected a list`)
    const before = resources.length
    for (const resource of value as unknown[]) {
      if (!resource || typeof resource !== 'object') continue
      const id = (resource as { id?: unknown }).id
      if (typeof id === 'string') {
        if (seen.has(id)) continue
        seen.add(id)
      }
      resources.push(resource)
    }
    // Without X-Paging-Limit the registry is not paging: that was all of it.
    const until = response.headers['x-paging-until']
    if (!paging || response.headers['x-paging-limit'] === undefined || value.length === 0) {
      return resources
    }
    if (resources.length === before || !until || until === since) return resources
    since = until
  }
  partial.push(
    `${collection.replace(/\/$/, '').split('/').pop()} past the first ${MAX_PAGES * PAGE_SIZE}`
  )
  return resources
}

/** A registry read failure, as the probe says it; anything else is a bug. */
export const readFailure = (err: unknown): string | null =>
  err instanceof ReadError ? err.message : null

// --- What the probe says ------------------------------------------------------

/** The findings as lines for the probe's list, errors first: at most `max`. */
export function findingLines(report: RegistryReport, max = 50): string[] {
  const rank = { error: 0, warning: 1, info: 2 } as const
  const shown = report.findings
    .filter((f) => f.severity !== 'info')
    .sort((a, b) => rank[a.severity] - rank[b.severity])
  const lines = shown.slice(0, max).map((f) => {
    const where = f.resource ? `${f.resource.label} (${f.resource.kind})` : 'The registry'
    return (
      `${f.severity === 'error' ? 'Fault' : 'Warning'}: ${where}: ${f.message}` +
      (f.line !== null ? ` (SDP line ${f.line})` : '')
    )
  })
  if (shown.length > max) lines.push(`…and ${shown.length - max} more.`)
  return lines
}

/** "12 nodes, 40 senders (38 active), 60 receivers (22 taking a stream)", and the clocks. */
export function registrySummary(report: RegistryReport): string {
  const s = report.summary
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
  const clocks =
    s.grandmasters.length === 1
      ? ` Every registered clock follows grandmaster ${s.grandmasters[0]!.id}` +
        (s.unlocked_clocks > 0
          ? `, and ${plural(s.unlocked_clocks, 'clock is', 'clocks are')} not locked`
          : '') +
        '.'
      : s.grandmasters.length > 1
        ? ` Registered clocks follow ${s.grandmasters.length} different grandmasters: ` +
          s.grandmasters.map((g) => `${g.id} (${g.clocks})`).join(', ') +
          '.'
        : ''
  return (
    `${plural(s.nodes, 'node')}, ${plural(s.senders, 'sender')} (${s.active_senders} active), ` +
    `${plural(s.receivers, 'receiver')} (${s.active_receivers} taking a stream).${clocks}`
  )
}
