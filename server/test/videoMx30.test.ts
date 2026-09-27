import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { gradeReading } from '@crewbox/shared'
import { ABSENT_AFTER, CoexReader, type CoexIo, type ReadOnlyInit } from '../src/video/coex.ts'
import { parseAnnouncement } from '../src/video/discovery.ts'

/**
 * The reader against the second COEX controller anybody has read: an MX30,
 * firmware V1.5.1, on 2026-09-26.
 *
 * Two fixtures, both from novasun and both real structure with synthetic
 * values. `mx30Api.json` is the unit connected and lit. `mx30UnpluggedApi.json`
 * is the same unit, powered, with **every output data line pulled** — and its
 * `monitor/info` reads exactly like the connected one: every cabinet listed,
 * every link up, temperatures reading. Only the connected-cabinet count, the
 * connected-cabinet list and the per-output link flags changed.
 *
 * novasun ran this reader against that fixture before any of the changes
 * these tests pin, and it graded the dark wall **`ok, "3 cabinets, 44°C"`**
 * on every poll. That is the headline. The rest are the MX30's other
 * surprises: an absent path answers HTTP 200 with an empty body instead of
 * 404; display state lives at a path the manual doesn't name; identity is at
 * `/device/hw`, beside a field called `randomPassword` served to anyone.
 */

type Fixture = Record<string, unknown>

const load = (name: string): Fixture =>
  JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')) as Fixture

const CONNECTED = load('mx30Api.json')
const UNPLUGGED = load('mx30UnpluggedApi.json')

interface Marker {
  __http_status__?: number
  __empty_body__?: boolean
}

/**
 * Serves a fixture the way the unit did.
 *
 * `{ __http_status__: 200, __empty_body__: true }` is novasun's marker for a
 * path that answered 200 with `Content-Length: 0` (OBSERVED with `curl -i`),
 * so it answers `ok` with an empty `text()` — and a `json()` that throws, as
 * `fetch` does, in case anything reaches for it. Paths not in the fixture
 * answer the same way, because that is what this firmware does with a path it
 * doesn't have; a 404 is served only where the fixture says so.
 */
function harness(fixture: Fixture) {
  const api = structuredClone(fixture)
  let clock = 1_000
  const requests: string[] = []
  const io: CoexIo = {
    fetch: (url: string, init: ReadOnlyInit) => {
      const path = new URL(url).pathname
      requests.push(`${init.method} ${path}`)
      const body = api[path] as (Marker & Record<string, unknown>) | undefined
      if (body?.__http_status__ === 404) {
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) })
      }
      const text = body === undefined || body.__empty_body__ ? '' : JSON.stringify(body)
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(JSON.parse(text) as unknown),
        text: () => Promise.resolve(text),
      })
    },
    now: () => clock,
    wait: (ms: number) => {
      clock += ms
      return Promise.resolve()
    },
  }
  return { io, api, requests }
}

describe('the COEX reader against an MX30', () => {
  it('grades a connected wall healthy, and says what it is', async () => {
    const { io, requests } = harness(CONNECTED)
    const reading = await new CoexReader('192.0.2.30', io).poll()
    expect(requests.every((r) => r.startsWith('GET '))).toBe(true)
    expect(reading.model).toBe('MX30')
    expect(reading.firmware).toBe('V1.5.1')
    expect(reading.connectedCabinets).toBe(3)
    expect(reading.displayMode).toBe('normal')
    expect(reading.outputsDown).toBeUndefined()
    expect(reading.errors).toEqual([])
    expect(gradeReading(reading)).toEqual({ health: 'ok', summary: '3 cabinets, 44°C' })
  })

  it('calls a wall with every line unplugged what it is', async () => {
    // The false all-clear. monitor/info here is the connected wall's, down to
    // the temperatures; the count and the links are what moved.
    const { io } = harness(UNPLUGGED)
    const reader = new CoexReader('192.0.2.30', io)
    for (let poll = 1; poll <= 21; poll++) {
      const reading = await reader.poll()
      expect(reading.connectedCabinets).toBe(0)
      expect(reading.cabinets.every((c) => !c.online)).toBe(true)
      expect(gradeReading(reading)).toEqual({ health: 'fault', summary: 'no cabinets connected' })
    }
  })

  it('names the cabinets behind a pulled line, and leaves the rest', async () => {
    // One output out, its cabinet gone from the count. Which cabinet comes
    // from the output it hangs off, not from a guess about the list.
    const { io, api } = harness(CONNECTED)
    const monitor = api['/api/v1/device/monitor/info'] as {
      outputStatus: Array<{ outputID: number; linkStatus: boolean }>
    }
    monitor.outputStatus.find((o) => o.outputID === 2050)!.linkStatus = false
    const count = api['/api/v1/screen/cabinet/count'] as { list: Array<{ CabinetCount: number }> }
    count.list[0].CabinetCount = 2

    const reading = await new CoexReader('192.0.2.30', io).poll()
    expect(reading.outputsDown).toEqual(['2050'])
    expect(reading.cabinets.filter((c) => !c.online).map((c) => c.output)).toEqual(['2050'])
    expect(gradeReading(reading)).toEqual({
      health: 'fault',
      summary: '1 of 3 cabinets not connected',
    })
  })

  it('warns about a dropped link that the count says lost nothing', async () => {
    // A redundant loop carries the cabinets from its backup port: dark is one
    // cable away, and nothing is dark yet.
    const { io, api } = harness(CONNECTED)
    const monitor = api['/api/v1/device/monitor/info'] as {
      outputStatus: Array<{ outputID: number; linkStatus: boolean }>
    }
    monitor.outputStatus.find((o) => o.outputID === 2048)!.linkStatus = false

    const reading = await new CoexReader('192.0.2.30', io).poll()
    expect(reading.cabinets.every((c) => c.online)).toBe(true)
    expect(gradeReading(reading)).toEqual({ health: 'warn', summary: 'output 2048 link down' })
  })

  it('ignores backup and unused outputs with nothing behind them', async () => {
    // 2049 and 2051 are backup ports on this unit (OBSERVED), and ten or more
    // outputs are always unused. Their links mean nothing on their own.
    const { io, api } = harness(CONNECTED)
    const monitor = api['/api/v1/device/monitor/info'] as {
      outputStatus: Array<{ outputID: number; linkStatus: boolean }>
    }
    monitor.outputStatus.find((o) => o.outputID === 2049)!.linkStatus = false
    const reading = await new CoexReader('192.0.2.30', io).poll()
    expect(reading.outputsDown).toBeUndefined()
    expect(gradeReading(reading).health).toBe('ok')
  })

  it.each([
    [2, 'freeze', 'frozen'],
    [1, 'blackout', 'blacked out'],
  ] as const)('sees display mode %i as %s', async (code, mode, summary) => {
    // Both OBSERVED on this unit from its front panel, at this endpoint. The
    // manual's `displaymode`, which this reader used to ask, is an empty 200.
    const { io, api } = harness(CONNECTED)
    const state = api['/api/v1/screen/output/display/state'] as {
      displayState: Array<{ displayMode: number }>
    }
    state.displayState[0].displayMode = code
    const reading = await new CoexReader('192.0.2.30', io).poll()
    expect(reading.displayMode).toBe(mode)
    expect(gradeReading(reading)).toEqual({ health: 'warn', summary })
  })

  it('reads a display mode it cannot map as unknown, never as normal', async () => {
    const { io, api } = harness(CONNECTED)
    const state = api['/api/v1/screen/output/display/state'] as {
      displayState: Array<{ displayMode: number }>
    }
    state.displayState[0].displayMode = 7
    const reading = await new CoexReader('192.0.2.30', io).poll()
    expect(reading.displayMode).toBeUndefined()
  })

  it('never lets randomPassword out of the reader', async () => {
    // Served to any GET of /device/hw, purpose unknown. The fixture carries
    // an obviously fake value so this can look for it.
    const { io } = harness(CONNECTED)
    expect(JSON.stringify(CONNECTED['/api/v1/device/hw'])).toContain('randomPassword')
    const reading = await new CoexReader('192.0.2.30', io).poll()
    const out = JSON.stringify(reading)
    expect(out).not.toContain('randomPassword')
    expect(out).not.toContain('00000000"')
  })

  it('takes an empty 200 as absent, and stops asking', async () => {
    // Without /device/hw, the reader falls back to the manual's /device —
    // which this firmware answers with 200 and no body. That used to read as
    // "no answer" on every sweep for as long as the box ran.
    const fixture = structuredClone(CONNECTED)
    delete fixture['/api/v1/device/hw']
    const { io, requests } = harness(fixture)
    const reader = new CoexReader('192.0.2.30', io)
    let last = await reader.poll()
    expect(last.errors).toContain('/api/v1/device/hw answered empty')
    expect(last.errors).toContain('/api/v1/device answered empty')
    // Latching counts polls that ask; topology is every tenth.
    for (let poll = 2; poll <= 10 * ABSENT_AFTER + 1; poll++) last = await reader.poll()
    expect(last.absent).toEqual(expect.arrayContaining(['/api/v1/device/hw', '/api/v1/device']))
    expect(last.errors).toEqual([])
    const before = requests.length
    await reader.poll()
    expect(requests.slice(before)).not.toContain('GET /api/v1/device')
  })

  it("says who holds the controller's lock", async () => {
    const { io, api } = harness(CONNECTED)
    api['/api/v1/device/hw/lock'] = { locked: 1, ip: '192.0.2.50' }
    const reading = await new CoexReader('192.0.2.30', io).poll()
    expect(reading.lockedBy).toBe('192.0.2.50')
  })

  it('reports a refused connection as refused', async () => {
    // At a front-panel power-off the unit refused every connection for the
    // 7.5 minutes it was watched, never timing out (OBSERVED).
    const io: CoexIo = {
      fetch: () =>
        Promise.reject(
          Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
        ),
      now: () => 1_000,
      wait: () => Promise.resolve(),
    }
    const reading = await new CoexReader('192.0.2.30', io).poll()
    expect(reading.answered).toBe(0)
    expect(reading.errors.length).toBeGreaterThan(0)
    expect(reading.errors.every((e) => e.endsWith(' refused'))).toBe(true)
  })
})

describe("an MX30's announcement", () => {
  const ANNOUNCEMENT = load('mx30Announcement.json') as { payload: string }

  it('is recognised from the bytes the unit sends', () => {
    expect(parseAnnouncement(Buffer.from(ANNOUNCEMENT.payload, 'ascii'))).toEqual({
      apiPort: '8001',
    })
  })

  it('is not confused with a probe reply or noise', () => {
    expect(parseAnnouncement(Buffer.from('rpProMI:App,0161', 'ascii'))).toBeNull()
    expect(parseAnnouncement(Buffer.from('{"data":[]}', 'ascii'))).toBeNull()
    expect(parseAnnouncement(Buffer.from('{"data":[{"apiPort":"80; rm"}]}'))).toBeNull()
  })
})
