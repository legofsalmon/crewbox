import { describe, expect, it } from 'vitest'
import {
  BUSY_CODE,
  CoexReader,
  TOPOLOGY_EVERY,
  displayModeOf,
  parseCabinets,
  parseInputs,
  readingIsEmpty,
  unwrap,
  type CoexIo,
} from '../src/video/coex.ts'

/**
 * The COEX HTTP reader.
 *
 * The point of most of this file is the provenance note in `coex.ts`: the
 * endpoint *paths* are official but the response *field names* are not
 * verified against firmware, so the reader tries several spellings and
 * leaves a gap where none match. These tests pin both halves — that a
 * plausible payload is read, and that an unrecognised one produces absence
 * rather than a made-up number.
 */

interface Recorded {
  url: string
  method: string
}

function fakeIo(routes: Record<string, unknown>, recorded: Recorded[] = []): CoexIo {
  return {
    fetch: (url, init) => {
      recorded.push({ url, method: init.method })
      const path = new URL(url).pathname
      const body = routes[path]
      if (body === undefined) {
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) })
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
    },
    now: () => 1_000,
    wait: () => Promise.resolve(),
  }
}

const FULL = {
  '/api/v1/device': {
    code: 0,
    data: { model: 'MX40 Pro', name: 'Main wall', sn: 'SN-42', version: 'v1.4.0' },
  },
  '/api/v1/device/cabinet': {
    code: 0,
    data: [
      { id: 'A1', online: true },
      { id: 'A2', online: true },
    ],
  },
  '/api/v1/screen': { code: 0, data: [{ id: 1, brightness: 70 }] },
  '/api/v1/device/snmpstate': { code: 0, data: { enable: false } },
  '/api/v1/device/monitor/info': {
    code: 0,
    data: {
      temperature: 38,
      fanSpeed: 55,
      cabinets: [
        { id: 'A1', online: true, temperature: 44 },
        { id: 'A2', online: false, temperature: 43 },
      ],
    },
  },
  '/api/v1/device/screen/displaymode': { code: 0, data: { mode: 0 } },
  '/api/v1/device/input/sources': {
    code: 0,
    data: [{ id: 1, name: 'SDI 1', type: '12G-SDI', signalStatus: 1 }],
  },
  '/api/v1/device/backup': { code: 0, data: { isBackup: false } },
}

describe('envelopes', () => {
  it('unwraps { code, data }', () => {
    expect(unwrap({ code: 0, data: { a: 1 } })).toEqual({ data: { a: 1 }, busy: false })
  })

  it('flags Busying so the caller backs off instead of retrying', () => {
    expect(unwrap({ code: BUSY_CODE }).busy).toBe(true)
  })

  it('passes a bare payload through, since not every firmware wraps', () => {
    expect(unwrap([{ id: 1 }]).data).toEqual([{ id: 1 }])
  })
})

describe('provisional field names', () => {
  it('reads the spellings the manual and the published clients use', () => {
    expect(parseCabinets([{ cabinetId: 'B3', isOnline: false, temp: 51 }])).toEqual([
      { id: 'B3', online: false, temperature: 51 },
    ])
  })

  it('treats a cabinet that did not say as online, not as down', () => {
    // A sparse payload must not paint a working wall red — the pane's only
    // alarm is worthless if it cries wolf on a firmware that omits a field.
    expect(parseCabinets([{ id: 'C1' }])[0].online).toBe(true)
  })

  it('leaves a gap when no spelling matches, rather than guessing', () => {
    const [cabinet] = parseCabinets([{ id: 'D1', celsiusMaybe: 61 }])
    expect(cabinet.temperature).toBeUndefined()
  })

  it('reads the three input signal states', () => {
    expect(
      parseInputs([
        { id: 1, signalStatus: 0 },
        { id: 2, signalStatus: 1 },
        { id: 3, signalStatus: 2 },
      ])
    ).toEqual([
      { id: '1', signal: 'not-connected' },
      { id: '2', signal: 'present' },
      { id: '3', signal: 'no-signal' },
    ])
  })

  it('maps display mode the COEX way round', () => {
    // Blackout and freeze are swapped between this API and the VX4S register
    // map. This reader only ever speaks COEX; getting it backwards would show
    // a frozen wall as blacked out.
    expect(displayModeOf(0)).toBe('normal')
    expect(displayModeOf(1)).toBe('blackout')
    expect(displayModeOf(2)).toBe('freeze')
  })
})

describe('polling', () => {
  it('reads a whole controller', async () => {
    const reader = new CoexReader('10.0.30.11', fakeIo(FULL))
    const reading = await reader.poll()
    expect(reading.readPath).toBe('http')
    expect(reading.model).toBe('MX40 Pro')
    expect(reading.reportedName).toBe('Main wall')
    expect(reading.temperature).toBe(38)
    expect(reading.brightness).toBe(70)
    expect(reading.snmpEnabled).toBe(false)
    expect(reading.displayMode).toBe('normal')
    expect(reading.cabinets).toHaveLength(2)
    expect(reading.inputs).toEqual([
      { id: '1', name: 'SDI 1', connector: '12G-SDI', signal: 'present' },
    ])
    expect(reading.errors).toEqual([])
  })

  it('only ever issues GET', async () => {
    const recorded: Recorded[] = []
    const reader = new CoexReader('10.0.30.11', fakeIo(FULL, recorded))
    await reader.poll()
    expect(recorded.length).toBeGreaterThan(0)
    expect(recorded.every((r) => r.method === 'GET')).toBe(true)
  })

  it('re-reads topology only every tenth poll', async () => {
    const recorded: Recorded[] = []
    const reader = new CoexReader('10.0.30.11', fakeIo(FULL, recorded))
    for (let i = 0; i < TOPOLOGY_EVERY; i++) await reader.poll()
    const identityReads = recorded.filter((r) => r.url.endsWith('/api/v1/device')).length
    expect(identityReads).toBe(1)
  })

  it('keeps the last topology on a status-only poll', async () => {
    const reader = new CoexReader('10.0.30.11', fakeIo(FULL))
    await reader.poll()
    const second = await reader.poll()
    // The identity endpoint was not asked this time round, but the row still
    // has to say which processor it is.
    expect(second.model).toBe('MX40 Pro')
  })

  it('records a missing endpoint and finishes the poll', async () => {
    const partial = { ...FULL }
    delete (partial as Record<string, unknown>)['/api/v1/device/backup']
    const reader = new CoexReader('10.0.30.11', fakeIo(partial))
    const reading = await reader.poll()
    expect(reading.errors).toEqual(['/api/v1/device/backup answered 404'])
    // The rest of the poll still landed — one unimplemented endpoint costs
    // that row, not the pane.
    expect(reading.model).toBe('MX40 Pro')
    expect(reading.cabinets).toHaveLength(2)
  })

  it('backs off rather than hammering a busy controller', async () => {
    const io = fakeIo({ '/api/v1/device': { code: BUSY_CODE } })
    const reader = new CoexReader('10.0.30.11', io)
    await reader.poll()
    expect(reader.backingOff).toBe(true)
  })

  it('reports an empty reading when nothing answers at all', async () => {
    const reader = new CoexReader('10.0.30.11', fakeIo({}))
    const reading = await reader.poll()
    expect(readingIsEmpty(reading)).toBe(true)
    expect(reading.errors.length).toBeGreaterThan(0)
  })
})
