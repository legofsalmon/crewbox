import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clip, scrub } from '../src/reports/scrub.ts'
import {
  LIMITS,
  MAX_BODY_BYTES,
  buildCrashReport,
  buildFeedbackReport,
  crashSignature,
  hostArch,
  hostOs,
  type ReportOrigin,
} from '../src/reports/payload.ts'
import { MAX_QUEUED, ReportQueue } from '../src/reports/queue.ts'
import { claimRunMarker, releaseRunMarker } from '../src/reports/marker.ts'
import {
  AUTO_SEND_KEY,
  INSTALL_KEY,
  ReportService,
  SEND_TIMEOUT_MS,
  type ReportFetch,
} from '../src/reports/service.ts'

/**
 * Crash reports and feedback leaving the box.
 *
 * The four things the intake contract asks every app to prove: the scrubber,
 * the payload builder (limits, nothing forbidden), the queue, and that with
 * the setting off and nobody pressing Send, nothing is sent at all.
 */

const dirs: string[] = []
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'crewbox-reports-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const origin: ReportOrigin = {
  version: '1.0.0+abc1234',
  os: 'macos',
  osVersion: '24.6.0',
  arch: 'arm64',
  install: '0mf3k2x1a9b8c7d6e5f4g3',
}

describe('the scrubber', () => {
  const ctx = { home: '/Users/sam.okafor', user: 'sam.okafor' }

  it('folds the home directory to ~', () => {
    expect(scrub('at load (/Users/sam.okafor/Shows/Glasto.json:1:2)', ctx)).toBe(
      'at load (~/Shows/Glasto.json:1:2)'
    )
  })

  it('does the same for a Windows home, in either slash direction', () => {
    const win = { home: 'C:\\Users\\Sam', user: 'Sam' }
    expect(scrub('open C:\\Users\\Sam\\AppData\\crewbox.db', win)).toBe(
      'open ~\\AppData\\crewbox.db'
    )
    expect(scrub('file:///C:/Users/Sam/x.txt', win)).toBe('file:///~/x.txt')
    expect(scrub('open c:\\users\\sam\\x', win)).toBe('open ~\\x')
  })

  it("takes other people's user names out of paths too", () => {
    expect(scrub('/home/alex/crewbox and /Users/jo/x and D:\\Users\\kim\\y', ctx)).toBe(
      '/home/<user>/crewbox and /Users/<user>/x and D:\\Users\\<user>\\y'
    )
  })

  it('removes the login name wherever it is a path segment', () => {
    expect(scrub('/Volumes/sam.okafor/backup', ctx)).toBe('/Volumes/<user>/backup')
  })

  it('drops everything after ? in a URL', () => {
    expect(scrub('GET https://box.local:8787/api/files/abc?token=s3cret&x=1 failed', ctx)).toBe(
      'GET https://box.local:8787/api/files/abc failed'
    )
    expect(scrub('see http://example.com/a#section-2', ctx)).toBe('see http://example.com/a')
  })

  it('removes addresses of other devices and email addresses', () => {
    expect(scrub('connect ECONNREFUSED 192.168.1.20:6454', ctx)).toBe(
      'connect ECONNREFUSED <ip>:6454'
    )
    expect(scrub('bind fe80::1c2a:3bff:fe4d:5e6f failed', ctx)).toBe('bind <ip> failed')
    expect(scrub('no seat for jo@example.com', ctx)).toBe('no seat for <email>')
  })

  it('leaves a version number and a source position alone', () => {
    expect(scrub('crewbox 1.0.0 at app.ts:120:15', ctx)).toBe('crewbox 1.0.0 at app.ts:120:15')
  })

  it('never splits an emoji when it cuts', () => {
    const cut = clip('ab😀', 3)
    expect(cut).toBe('ab')
    expect(() => JSON.parse(JSON.stringify(cut))).not.toThrow()
  })
})

describe('the crash payload', () => {
  it('has exactly the contract fields, filled from the right places', () => {
    const report = buildCrashReport(
      {
        kind: 'exception',
        summary: 'TypeError: x is undefined\nsecond line',
        detail: 'TypeError: x is undefined\n    at f (/snapshot/server/app.js:10:5)',
        occurredAt: new Date('2026-09-24T02:10:00Z'),
      },
      origin
    )
    expect(Object.keys(report).sort()).toEqual(
      [
        'arch',
        'detail',
        'install',
        'kind',
        'occurredAt',
        'os',
        'osVersion',
        'product',
        'signature',
        'summary',
        'version',
      ].sort()
    )
    expect(report).toMatchObject({
      product: 'crewbox',
      version: '1.0.0+abc1234',
      os: 'macos',
      kind: 'exception',
      summary: 'TypeError: x is undefined',
      occurredAt: '2026-09-24T02:10:00.000Z',
    })
  })

  it('cuts every field to its limit', () => {
    const report = buildCrashReport(
      {
        kind: 'other',
        summary: 'x'.repeat(1000),
        detail: 'y'.repeat(100_000),
        note: 'z'.repeat(10_000),
      },
      { ...origin, version: '9'.repeat(100), osVersion: '8'.repeat(100), arch: 'a'.repeat(50) }
    )
    expect(report.summary.length).toBe(LIMITS.summary)
    expect(report.detail?.length).toBe(LIMITS.detail)
    expect(report.note?.length).toBe(LIMITS.note)
    expect(report.version.length).toBe(LIMITS.version)
    expect(report.osVersion?.length).toBe(LIMITS.osVersion)
    expect(report.arch?.length).toBe(LIMITS.arch)
    expect(report.signature?.length).toBeLessThanOrEqual(LIMITS.signature)
  })

  it('stays under 64 KB even when the trace is multi-byte', () => {
    const report = buildCrashReport(
      { kind: 'exception', summary: 'boom', detail: '€'.repeat(40_000) },
      origin
    )
    expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(MAX_BODY_BYTES)
    expect(report.detail?.startsWith('€€€')).toBe(true)
  })

  it('never carries anything it was not built with, however it is called', () => {
    const report = buildCrashReport(
      {
        kind: 'panic',
        summary: 'boom',
        // What a careless caller might hand it.
        ...({
          licence: 'LT-CREW-AAAA',
          email: 'a@b.co',
          name: 'Sam',
          eventName: 'Glasto',
        } as object),
      },
      origin
    )
    const body = JSON.stringify(report)
    for (const forbidden of ['LT-CREW', 'a@b.co', 'Sam', 'Glasto', 'licence', 'email', 'name']) {
      expect(body).not.toContain(forbidden)
    }
  })

  it('scrubs the summary, the trace and the note', () => {
    const report = buildCrashReport(
      {
        kind: 'exception',
        summary: 'ENOENT: /Users/sam/Shows/x.json',
        detail: 'at /Users/sam/crewbox/app.js:1:1',
        note: 'I opened http://10.0.0.5/?pin=1234',
      },
      origin,
      { home: '/Users/sam', user: 'sam' }
    )
    expect(report.summary).toBe('ENOENT: ~/Shows/x.json')
    expect(report.detail).toBe('at ~/crewbox/app.js:1:1')
    expect(report.note).toBe('I opened http://<ip>/')
  })

  it('drops an install id the server would refuse', () => {
    const report = buildCrashReport(
      { kind: 'other', summary: 'x' },
      { ...origin, install: 'not/valid id' }
    )
    expect(report.install).toBeUndefined()
  })

  it('gives the same crash the same signature across builds and line numbers', () => {
    const a = crashSignature('exception', 'port 8787 busy', 'Error\n    at listen (a.js:10:5)')
    const b = crashSignature('exception', 'port 9000 busy', 'Error\n    at listen (a.js:99:1)')
    const c = crashSignature('exception', 'port 8787 busy', 'Error\n    at close (a.js:10:5)')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  it('names the host in the contract’s words', () => {
    expect(hostOs('darwin')).toBe('macos')
    expect(hostOs('win32')).toBe('windows')
    expect(hostOs('linux')).toBe('linux')
    expect(hostArch('x64')).toBe('x86_64')
    expect(hostArch('arm64')).toBe('arm64')
  })
})

describe('the feedback payload', () => {
  it('sends email, name, licence and public only when given', () => {
    const bare = buildFeedbackReport({ type: 'idea', message: '  More faders  ' }, origin)
    expect(bare).toEqual({
      product: 'crewbox',
      version: '1.0.0+abc1234',
      os: 'macos',
      install: origin.install,
      type: 'idea',
      message: 'More faders',
    })
    const full = buildFeedbackReport(
      {
        type: 'bug',
        message: 'x',
        email: 'sam@example.com',
        licence: 'LT-CREW-1',
        public: true,
      },
      origin
    )
    expect(full).toMatchObject({ email: 'sam@example.com', licence: 'LT-CREW-1', public: true })
    const notPublic = buildFeedbackReport({ type: 'bug', message: 'x', public: false }, origin)
    expect('public' in notPublic).toBe(false)
  })

  it('cuts the message and email to their limits', () => {
    const report = buildFeedbackReport(
      { type: 'question', message: 'm'.repeat(9000), email: `${'e'.repeat(300)}@x.io` },
      origin
    )
    expect(report.message.length).toBe(LIMITS.message)
    expect(report.email?.length).toBe(LIMITS.email)
  })
})

describe('the queue', () => {
  const crash = (summary: string) =>
    ({
      endpoint: 'crash',
      consent: 'pending',
      payload: buildCrashReport({ kind: 'other', summary }, origin),
    }) as const

  it('keeps reports in the order they were queued, across restarts', () => {
    const dir = tempDir()
    const first = new ReportQueue(dir)
    first.add(crash('one'))
    first.add(crash('two'))
    const again = new ReportQueue(dir)
    expect(again.list().map((e) => (e.endpoint === 'crash' ? e.payload.summary : ''))).toEqual([
      'one',
      'two',
    ])
  })

  it(`holds at most ${MAX_QUEUED}, dropping the oldest`, () => {
    const queue = new ReportQueue(tempDir())
    for (let i = 0; i < MAX_QUEUED + 5; i++) queue.add(crash(`n${i}`))
    const summaries = queue.list().map((e) => (e.endpoint === 'crash' ? e.payload.summary : ''))
    expect(summaries).toHaveLength(MAX_QUEUED)
    expect(summaries[0]).toBe('n5')
    expect(summaries.at(-1)).toBe(`n${MAX_QUEUED + 4}`)
  })

  it('throws away a file it cannot read instead of choking on it', () => {
    const dir = tempDir()
    const queue = new ReportQueue(dir)
    queue.add(crash('good'))
    writeFileSync(join(dir, '000000000aaaaaaaaaaaa.json'), '{"endpoint":')
    expect(queue.list()).toHaveLength(1)
    expect(readdirSync(dir)).toHaveLength(1)
  })

  it('never throws when the disk will not take the write', () => {
    const dir = tempDir()
    const blocker = join(dir, 'file')
    writeFileSync(blocker, '')
    // A directory that is really a file: every write fails.
    const queue = new ReportQueue(join(blocker, 'reports'))
    expect(queue.add(crash('x'))).toBeNull()
    expect(queue.list()).toEqual([])
  })
})

describe('the run marker', () => {
  it('finds a run that never said it stopped, once', () => {
    const dir = tempDir()
    const dead = new Set([111])
    const io = { alive: (pid: number) => !dead.has(pid) }
    expect(claimRunMarker(dir, { pid: 111, version: '1.0.0', startedAt: 1 }, io)).toEqual([])
    // 111 died without releasing. The next run finds it...
    const found = claimRunMarker(dir, { pid: 222, version: '1.0.0', startedAt: 2 }, io)
    expect(found).toEqual([{ pid: 111, version: '1.0.0', startedAt: 1 }])
    // ...and the one after that does not find it again.
    releaseRunMarker(dir, 222)
    expect(claimRunMarker(dir, { pid: 333, version: '1.0.0', startedAt: 3 }, io)).toEqual([])
  })

  it('says nothing about a clean shutdown', () => {
    const dir = tempDir()
    const io = { alive: () => false }
    claimRunMarker(dir, { pid: 10, version: '1.0.0', startedAt: 1 }, io)
    releaseRunMarker(dir, 10)
    expect(claimRunMarker(dir, { pid: 11, version: '1.0.0', startedAt: 2 }, io)).toEqual([])
  })

  it('leaves alone a run that is still going — the other half of an update', () => {
    const dir = tempDir()
    claimRunMarker(dir, { pid: 50, version: '1.0.0', startedAt: 1 }, { alive: () => true })
    expect(
      claimRunMarker(dir, { pid: 51, version: '1.0.1', startedAt: 2 }, { alive: () => true })
    ).toEqual([])
    // Each removes only its own.
    releaseRunMarker(dir, 51)
    expect(readdirSync(dir)).toEqual(['running-50.json'])
  })
})

describe('sending', () => {
  interface Sent {
    url: string
    headers: Record<string, string>
    body: Record<string, unknown>
  }

  const settingsStore = () => {
    const rows = new Map<string, string>()
    return {
      rows,
      getSetting: (k: string) => rows.get(k),
      setSetting: (k: string, v: string) => void rows.set(k, v),
    }
  }

  const service = (
    opts: {
      status?: number | 'offline' | 'hang'
      outbound?: boolean
      settings?: ReturnType<typeof settingsStore>
      sent?: Sent[]
    } = {}
  ) => {
    const sent = opts.sent ?? []
    const fetch: ReportFetch = (url, init) => {
      sent.push({ url, headers: init.headers, body: JSON.parse(init.body) })
      if (opts.status === 'offline') return Promise.reject(new Error('getaddrinfo ENOTFOUND'))
      if (opts.status === 'hang') {
        return new Promise((_, reject) =>
          init.signal.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          })
        )
      }
      return Promise.resolve({ status: opts.status ?? 202 })
    }
    const reports = new ReportService({
      dir: tempDir(),
      settings: opts.settings ?? settingsStore(),
      version: '1.0.0+abc1234',
      outbound: opts.outbound ?? true,
      baseUrl: 'https://intake.example',
      fetch,
      scrubContext: { home: '/Users/sam', user: 'sam' },
    })
    return { reports, sent }
  }

  it('sends nothing when the setting is off and nobody pressed Send', async () => {
    const { reports, sent } = service()
    reports.recordCrash({ kind: 'exception', summary: 'boom' })
    reports.recordCrash({ kind: 'unclean-exit', summary: 'Crewbox closed unexpectedly' })
    await reports.flush()
    expect(sent).toEqual([])
    expect(reports.summary().pending).toHaveLength(2)
  })

  it('starts with the setting off', () => {
    const { reports } = service()
    expect(reports.autoSend()).toBe(false)
  })

  it('sends a crash straight away once the setting is on', async () => {
    const settings = settingsStore()
    settings.setSetting(AUTO_SEND_KEY, '1')
    const { reports, sent } = service({ settings })
    reports.recordCrash({ kind: 'exception', summary: 'boom at /Users/sam/x' })
    const result = await reports.flush()
    expect(result).toEqual({ sent: 1, dropped: 0, kept: 0 })
    expect(sent[0].url).toBe('https://intake.example/api/reports/crash')
    expect(sent[0].headers).toMatchObject({
      'Content-Type': 'application/json',
      'User-Agent': expect.stringMatching(/^Crewbox\/1\.0\.0\+abc1234 \((macos|windows|linux)\)$/),
    })
    expect(sent[0].body.summary).toBe('boom at ~/x')
    expect(reports.queue.list()).toEqual([])
  })

  it('sends what the admin said yes to, and turns the setting on only if asked', async () => {
    const { reports, sent } = service()
    reports.recordCrash({ kind: 'unclean-exit', summary: 'closed' })
    reports.decide({ send: true })
    expect(reports.autoSend()).toBe(false)
    await reports.flush()
    expect(sent).toHaveLength(1)

    const other = service()
    other.reports.recordCrash({ kind: 'unclean-exit', summary: 'closed' })
    other.reports.decide({ send: true, always: true })
    expect(other.reports.autoSend()).toBe(true)
  })

  it('deletes what the admin said no to, and sends none of it', async () => {
    const { reports, sent } = service()
    reports.recordCrash({ kind: 'unclean-exit', summary: 'closed' })
    reports.decide({ send: false })
    await reports.flush()
    expect(sent).toEqual([])
    expect(reports.queue.list()).toEqual([])
  })

  it('sends feedback because somebody pressed Send', async () => {
    const { reports, sent } = service()
    reports.submitFeedback({ type: 'idea', message: 'A cue light', public: false }, 'android')
    await reports.flush()
    expect(sent[0].url).toBe('https://intake.example/api/reports/feedback')
    expect(sent[0].body).toMatchObject({ product: 'crewbox', type: 'idea', os: 'android' })
    expect(sent[0].body).not.toHaveProperty('public')
  })

  it('keeps everything when there is no network, and stops trying for this round', async () => {
    const { reports, sent } = service({ status: 'offline' })
    reports.submitFeedback({ type: 'bug', message: 'a' }, 'web')
    reports.submitFeedback({ type: 'bug', message: 'b' }, 'web')
    expect(await reports.flush()).toEqual({ sent: 0, dropped: 0, kept: 2 })
    expect(sent).toHaveLength(1)
    expect(reports.queue.list()).toHaveLength(2)
    expect(reports.summary().lastError).toMatch(/try again later/)
  })

  it(`gives up on a request after ${SEND_TIMEOUT_MS / 1000} seconds and keeps the report`, async () => {
    vi.useFakeTimers()
    try {
      const { reports } = service({ status: 'hang' })
      reports.submitFeedback({ type: 'bug', message: 'a' }, 'web')
      let settled = false
      const done = reports.flush().then((r) => {
        settled = true
        return r
      })
      await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS - 1)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(await done).toEqual({ sent: 0, dropped: 0, kept: 1 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a report the server says it will never accept', async () => {
    for (const status of [400, 413]) {
      const { reports } = service({ status })
      reports.submitFeedback({ type: 'bug', message: 'a' }, 'web')
      expect(await reports.flush()).toEqual({ sent: 0, dropped: 1, kept: 0 })
      expect(reports.queue.list()).toEqual([])
    }
  })

  it('keeps a report the server rate-limited, and waits for the next launch', async () => {
    const { reports, sent } = service({ status: 429 })
    reports.submitFeedback({ type: 'bug', message: 'a' }, 'web')
    await reports.flush()
    await reports.flush()
    expect(sent).toHaveLength(1)
    expect(reports.queue.list()).toHaveLength(1)
  })

  it('keeps a report the server failed on, for next time', async () => {
    const { reports } = service({ status: 503 })
    reports.submitFeedback({ type: 'bug', message: 'a' }, 'web')
    expect(await reports.flush()).toEqual({ sent: 0, dropped: 0, kept: 1 })
  })

  it('never sends from a box told to make no outbound connections', async () => {
    const { reports, sent } = service({ outbound: false })
    reports.submitFeedback({ type: 'bug', message: 'a' }, 'web')
    await reports.flush()
    expect(sent).toEqual([])
    expect(reports.summary()).toMatchObject({ outbound: false, waiting: 1 })
  })

  it('records the same crash once while it is still queued', () => {
    const { reports } = service()
    reports.recordCrash({ kind: 'exception', summary: 'boom', detail: 'at f (a.js:1:1)' })
    reports.recordCrash({ kind: 'exception', summary: 'boom', detail: 'at f (a.js:1:1)' })
    expect(reports.queue.list()).toHaveLength(1)
  })

  it('makes one random install id and keeps it, derived from nothing', () => {
    const settings = settingsStore()
    const { reports } = service({ settings })
    const id = reports.installId()
    expect(id).toMatch(/^[a-z0-9]{21}$/)
    expect(reports.installId()).toBe(id)
    expect(settings.rows.get(INSTALL_KEY)).toBe(id)
  })
})
