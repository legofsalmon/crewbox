import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { gradeReading } from '@crewbox/shared'
import {
  ABSENT_AFTER,
  CoexReader,
  TOPOLOGY_EVERY,
  type CoexIo,
  type ReadOnlyInit,
} from '../src/video/coex.ts'

/**
 * The reader against a real controller's shapes.
 *
 * `videoCoex.test.ts` pins the reader against payloads written from the
 * manual and from `coexsim`. This file pins it against the only COEX API
 * anybody has actually read: a NovaPro MX40 Pro, mid-show, on 2026-09-11.
 * The fixture beside this file is that API — real structure, synthetic
 * values, three cabinets standing in for 288, the endpoints that answered
 * 404 marked as 404s.
 *
 * It earns its place because the manual was wrong on every row that named a
 * field, and the reader believed the manual. Driven with these shapes it
 * reported a live wall as healthy with no temperatures, no identity, every
 * input dark and cabinet labels that followed list position rather than
 * hardware. None of that was predicted from reading the code; it was
 * measured by running it, first in novasun's harness and now here.
 *
 * So: when a row below fails, the fixture is the evidence and the reader is
 * the thing to change.
 */

const API = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'mx40ProApi.json'), 'utf8')
) as Record<string, { __http_status__?: number } & Record<string, unknown>>

interface Harness {
  io: CoexIo
  requests: string[]
}

function harness(api: Record<string, unknown> = structuredClone(API)): Harness {
  let clock = 1_000
  const requests: string[] = []
  const io: CoexIo = {
    fetch: (url: string, init: ReadOnlyInit) => {
      const path = new URL(url).pathname
      requests.push(`${init.method} ${path}`)
      const body = api[path] as { __http_status__?: number } | undefined
      if (body === undefined || body.__http_status__ === 404) {
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) })
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
    },
    now: () => clock,
    wait: (ms: number) => {
      clock += ms
      return Promise.resolve()
    },
  }
  return { io, requests }
}

describe('the COEX reader against a real MX40 Pro', () => {
  it('reads every request as a GET, and nothing else', async () => {
    const { io, requests } = harness()
    await new CoexReader('192.0.2.1', io).poll()
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every((r) => r.startsWith('GET '))).toBe(true)
  })

  it('names the controller from monitor/info when /api/v1/device is absent', async () => {
    // OBSERVED: this firmware 404s /api/v1/device entirely, and the identity
    // it does offer is monitor/info.name — "MX40 Pro_000001". Without this the
    // pane has no idea what it is looking at.
    const { io } = harness()
    const reading = await new CoexReader('192.0.2.1', io).poll()
    expect(reading.errors).toContain('/api/v1/device answered 404')
    expect(reading.reportedName).toBe('MX40 Pro_000001')
  })

  it('reads the mainboard temperature out of a reading object', async () => {
    // OBSERVED: every reading on this firmware is
    // `{ name, nameEn, status, value }`, never a bare number. A reader that
    // assumed otherwise got undefined for the one number a screens tech
    // actually walks over to look at.
    const { io } = harness()
    const reading = await new CoexReader('192.0.2.1', io).poll()
    expect(reading.temperature).toBe(42)
  })

  it('reads fan speed as rpm, not as a percentage', async () => {
    // OBSERVED: `fanInfos[].fanSpeed` is rpm — 1293 on the unit reading 42°C.
    // `fanSpeed` is the percentage field and the pane prints it with a % sign,
    // so this must not land there.
    const { io } = harness()
    const reading = await new CoexReader('192.0.2.1', io).poll()
    expect(reading.fanRpm).toBe(1293)
    expect(reading.fanSpeed).toBeUndefined()
  })

  it('takes cabinet identity and temperature off the receiving card', async () => {
    // OBSERVED: `monitor/info.cabinets[].cabinetID` is always 0 and the
    // cabinet's own readings are 0. The real ones are on `rvCards[]`, and
    // `rvCards[].cabinetID` is the 64-bit id that joins to /device/cabinet.
    const { io } = harness()
    const reading = await new CoexReader('192.0.2.1', io).poll()
    expect(reading.cabinets.map((c) => c.id)).toEqual([
      '700000000000001',
      '700000000000002',
      '700000000000003',
    ])
    expect(reading.cabinets.map((c) => c.temperature)).toEqual([39, 41, 37])
  })

  it('keeps a cabinet bound to its hardware when monitor/info reorders', async () => {
    // OBSERVED, and the sharpest edge in the fixture: monitor/info returns its
    // cabinets in a different order on every call — all 288 of them moved
    // between two reads 35 minutes apart. Positional ids stay "1","2","3"
    // across that, so they *look* stable while the hardware behind each label
    // rotates, and anything trending per-cabinet temperature follows a
    // different cabinet every poll.
    const api = structuredClone(API)
    const { io } = harness(api)
    const reader = new CoexReader('192.0.2.1', io)

    const first = await reader.poll()
    const hot = first.cabinets.find((c) => c.id === '700000000000003')
    expect(hot).toBeDefined()

    const monitor = api['/api/v1/device/monitor/info'] as { cabinets: unknown[] }
    monitor.cabinets.reverse()
    const second = await reader.poll()

    // Same hardware, same reading, whatever order it arrived in.
    expect(second.cabinets.find((c) => c.id === '700000000000003')).toEqual(hot)
    expect(new Set(second.cabinets.map((c) => c.id))).toEqual(
      new Set(first.cabinets.map((c) => c.id))
    )
  })

  it('reads input signal from sourceStatus', async () => {
    // OBSERVED: signal is `sourceStatus` — 1 on the inputs feeding the show,
    // 0 elsewhere — not `signalStatus`. Reading the wrong key made every input
    // on a live wall report not-connected, HDMI 1 included, while it was
    // carrying the show.
    const { io } = harness()
    const reading = await new CoexReader('192.0.2.1', io).poll()
    expect(reading.inputs).toEqual([
      { id: '512', name: 'HDMI 1', signal: 'present' },
      { id: '768', name: 'DP 1', signal: 'not-connected' },
    ])
  })

  it('leaves the connector unlabelled rather than guessing at a type code', async () => {
    // `type` is an int code (3 on HDMI 1, 5 on DP 1) and nobody has mapped it.
    // The name already says "HDMI 1"; a wrong label on a screen is worse than
    // a blank one.
    const { io } = harness()
    const reading = await new CoexReader('192.0.2.1', io).poll()
    expect(reading.inputs.every((i) => i.connector === undefined)).toBe(true)
  })

  it('reads brightness off the cabinets as the 0-1 fraction it is', async () => {
    // OBSERVED: there is no screen-level brightness on this firmware. The
    // cabinets carry it, as a fraction — 0.8 — and the pane prints a percent.
    const { io } = harness()
    const reading = await new CoexReader('192.0.2.1', io).poll()
    expect(reading.brightness).toBe(80)
  })

  it('reports SNMP as off rather than as a failure', async () => {
    const { io } = harness()
    const reading = await new CoexReader('192.0.2.1', io).poll()
    expect(reading.snmpEnabled).toBe(false)
  })

  it('does not call a wall healthy on the strength of a cabinet count', async () => {
    // The verdict this whole file exists for. Before the fixture, driving the
    // reader with these shapes produced `ok, "3 cabinets online"` — from a
    // cabinet list whose every member was online only because the firmware
    // hadn't said otherwise, with no temperatures and every input dark.
    const { io } = harness()
    const reading = await new CoexReader('192.0.2.1', io).poll()
    const grade = gradeReading(reading)
    expect(grade.health).toBe('ok')
    // Earned: real per-card temperatures, not an absence of bad news.
    expect(grade.summary).toBe('3 cabinets, 41°C')
  })

  it('marks a cabinet offline when it stops appearing in monitor/info', async () => {
    // OBSERVED: this firmware has no online flag anywhere. A cabinet that
    // drops off the chain simply stops being listed, so the count falls from
    // 288 to 287 and nothing else changes. The stable /device/cabinet list is
    // what makes that legible.
    const api = structuredClone(API)
    const { io } = harness(api)
    const reader = new CoexReader('192.0.2.1', io)
    await reader.poll()

    const monitor = api['/api/v1/device/monitor/info'] as { cabinets: unknown[] }
    monitor.cabinets = monitor.cabinets.slice(0, 2)
    const second = await reader.poll()

    const gone = second.cabinets.find((c) => c.id === '700000000000003')
    expect(gone?.online).toBe(false)
    expect(gradeReading(second)).toEqual({
      health: 'fault',
      summary: 'cabinet 700000000000003 offline',
    })
  })

  it('stops asking for endpoints this firmware does not have', async () => {
    // Three of the eight endpoints 404 on this unit. Asking every poll puts
    // traffic on the video network for an answer that will not change, and
    // fills the pane with the same two failures for the length of the show.
    const { io, requests } = harness()
    const reader = new CoexReader('192.0.2.1', io)
    for (let i = 0; i < 5; i++) await reader.poll()

    const absent = '/api/v1/device/backup'
    expect(requests.filter((r) => r.endsWith(absent)).length).toBeLessThan(5)

    const last = await reader.poll()
    expect(last.errors.some((e) => e.includes(absent))).toBe(false)
    expect(last.absent).toContain(absent)
  })

  it('asks a missing endpoint again on the next topology sweep', async () => {
    // The other half of latching, and the reason it isn't a one-way door: a
    // controller rebooting part-way up, or one that grows an endpoint across
    // a firmware update, must not be written off for as long as the box runs.
    const { io, requests } = harness()
    const reader = new CoexReader('192.0.2.1', io)
    for (let i = 0; i < TOPOLOGY_EVERY * 2 + 1; i++) await reader.poll()

    // Three to latch, then one re-probe on each of the two topology sweeps.
    const asked = requests.filter((r) => r.endsWith('/api/v1/device/backup')).length
    expect(asked).toBe(ABSENT_AFTER + 2)
  })
})
