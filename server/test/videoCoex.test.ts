import { describe, expect, it } from 'vitest'
import { COEX_HTTP_PORT, REGISTER_BUS_PORT } from '@crewbox/shared'
import {
  assertReadOnly,
  BUSY_CODE,
  CoexReader,
  TOPOLOGY_EVERY,
  displayModeOf,
  modelFromName,
  parseCabinets,
  parseInputs,
  readingIsEmpty,
  unwrap,
  type CoexIo,
  type ReadOnlyInit,
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
  redirect: string
}

function fakeIo(routes: Record<string, unknown>, recorded: Recorded[] = []): CoexIo {
  return {
    fetch: (url, init) => {
      recorded.push({ url, method: init.method, redirect: init.redirect })
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

  it('does not read a numeric status as "offline"', () => {
    // `status` is a code everywhere else in this API — an input's signal
    // status is 0 not-connected, 1 present, 2 no-signal — and turning 0
    // into `false` painted a working wall red on a firmware that reports
    // cabinets that way.
    expect(parseCabinets([{ id: 'E1', status: 0 }])[0].online).toBe(true)
    expect(parseCabinets([{ id: 'E2', status: 1 }])[0].online).toBe(true)
    // An unambiguous field is still believed.
    expect(parseCabinets([{ id: 'E3', online: false }])[0].online).toBe(false)
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

  it('does not call a processor absent because none of its answers parsed', async () => {
    // "Nothing is there" used to be inferred from the fields: no cabinets,
    // no inputs, no model, no temperature, no display mode. A controller
    // answering every endpoint can land on all five — a wall not yet
    // configured, a firmware whose model sits under a key we do not read —
    // and was then reported as having no read path, which is the one
    // verdict that means "this address is not a processor at all".
    const reader = new CoexReader(
      '10.0.30.11',
      fakeIo({
        '/api/v1/device': { code: 0, data: { somethingElse: 'yes' } },
        '/api/v1/device/screen/list': { code: 0, data: { screens: [] } },
        '/api/v1/device/snmpstate': { code: 0, data: {} },
        '/api/v1/device/monitor/info': { code: 0, data: {} },
        '/api/v1/device/screen/displaymode': { code: 0, data: {} },
        '/api/v1/device/input/sources': { code: 0, data: { sources: [] } },
        '/api/v1/device/backup': { code: 0, data: {} },
      })
    )
    const reading = await reader.poll()
    // Nothing recognisable came back...
    expect(reading.model).toBeUndefined()
    expect(reading.cabinets).toHaveLength(0)
    expect(reading.inputs).toHaveLength(0)
    // ...but the controller is plainly there and answering.
    expect(readingIsEmpty(reading)).toBe(false)
  })
})

/**
 * The one way out of this module, and what it refuses.
 *
 * `ReadOnlyInit.method` being the literal `'GET'` is a real guard and it
 * stops at the compiler — which is exactly where a redirect starts. `fetch`
 * follows one unless told not to, so a host at the address an admin typed
 * could answer `302 Location: http://<processor>:5200/` and the box would
 * open TCP to the register bus and write an HTTP request into it, every
 * twenty seconds. That session is one NovaLCT may hold exclusively; taking it
 * could take the desk away from the operator using it, mid-show.
 *
 * Reproduced against a listener standing in for the bus before this existed.
 */
describe('what the read-only adapter refuses', () => {
  const init = (over: Partial<ReadOnlyInit> = {}): ReadOnlyInit => ({
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(1000),
    ...over,
  })

  it('accepts an ordinary read of the COEX API', () => {
    expect(() =>
      assertReadOnly(`http://10.0.30.11:${COEX_HTTP_PORT}/api/v1/device`, init())
    ).not.toThrow()
  })

  it('refuses to follow a redirect', () => {
    expect(() =>
      assertReadOnly(
        `http://10.0.30.11:${COEX_HTTP_PORT}/api/v1/device`,
        init({ redirect: 'follow' } as unknown as Partial<ReadOnlyInit>)
      )
    ).toThrow(/redirect/)
  })

  it('refuses the register bus outright', () => {
    // Where a followed redirect would have landed. Refused on the port,
    // before a socket is opened.
    expect(() => assertReadOnly(`http://10.0.30.11:${REGISTER_BUS_PORT}/`, init())).toThrow(
      String(REGISTER_BUS_PORT)
    )
  })

  it('refuses any port that is not the COEX API', () => {
    for (const port of [80, 443, 22, 5200]) {
      expect(() => assertReadOnly(`http://10.0.30.11:${port}/`, init())).toThrow(/read-only/)
    }
  })

  it('refuses a write verb, even though the type already does', () => {
    expect(() =>
      assertReadOnly(
        `http://10.0.30.11:${COEX_HTTP_PORT}/api/v1/device`,
        init({ method: 'POST' } as unknown as Partial<ReadOnlyInit>)
      )
    ).toThrow(/POST/)
  })

  it('asks for redirect: error on every request it makes', () => {
    // The type says so; this says the reader actually passes it.
    const recorded: Recorded[] = []
    const reader = new CoexReader('10.0.30.11', fakeIo({}, recorded))
    return reader.poll().then(() => {
      expect(recorded.length).toBeGreaterThan(0)
      for (const r of recorded) {
        expect(r.method).toBe('GET')
        expect(r.redirect).toBe('error')
      }
    })
  })
})

/**
 * The shapes a real MX40 Pro returns.
 *
 * Structure copied from novasun's `tests/fixtures/mx40_like_api.json`
 * (commit 23bf080), which was taken from a live unit on 2026-09-11 with every
 * value replaced. Three cabinets stand in for 288. Before these tests, the
 * reader driven with this payload graded the wall `ok`, "3 cabinets online",
 * with no temperatures, no identity and every input not-connected.
 */
const sensor = (value: number) => ({ name: '', nameEn: '', status: 0, value })
const CAB_IDS = [700000000000001, 700000000000002, 700000000000003]

const OBSERVED = {
  // '/api/v1/device' deliberately absent: the unit answered HTTP 404.
  '/api/v1/device/cabinet': CAB_IDS.map((id, i) => ({
    id,
    index: i,
    outputID: 2048,
    outputCardID: 8,
    canvasID: 2048,
    brightness: 0.8,
    gamma: { r: 2.8, g: 2.8, b: 2.8 },
    colorTemperature: 6500,
    resolution: { width: 128, height: 128 },
    rvCardName: 'A5sPlus',
    shortName: '',
  })),
  '/api/v1/screen': {
    screens: [{ screenID: '{s1}', screenName: 'Main', workingMode: 1, masterFrameRate: 50 }],
    screenGroups: [{ isShow: false, name: 'Group', ordinal: 0, screenGroupID: '{g}' }],
  },
  '/api/v1/device/snmpstate': { state: false },
  '/api/v1/device/monitor/info': {
    name: 'MX40 Pro_000001',
    runtime: 17160,
    totalRuntime: 986580,
    mainBoardTemperature: { name: 'Main_board Temperature', nameEn: '', status: 0, value: 42 },
    mainBoardVoltage: { name: 'Main_board Voltage', nameEn: '', status: 0, value: 11.45 },
    fanInfos: [
      {
        fanName: 'chassis Fan',
        fanNameEn: '',
        fanShowType: 0,
        fanSpeed: 1293,
        fanType: 0,
        status: 0,
      },
      {
        fanName: 'FPGA_A Fan',
        fanNameEn: '',
        fanShowType: 0,
        fanSpeed: 2785,
        fanType: 0,
        status: 0,
      },
    ],
    cardMonitorInfo: null,
    // Every entry says cabinetID 0 and reads 0; the card underneath is real.
    cabinets: CAB_IDS.map((id, i) => ({
      cabinetID: 0,
      canvasID: 0,
      index: i,
      outPutID: 2048,
      outputCardID: 8,
      rvCardID: 0,
      temperature: sensor(0),
      voltage: sensor(0),
      rvCards: [
        {
          cabinetID: id,
          rvCardID: id,
          cabinetIndex: i,
          temperature: sensor([39, 41, 37][i]),
          voltage: sensor([4.2, 4.1, 4.4][i]),
          humidity: sensor(0),
          nextCabinetLinkStatus: { linkStatus: true, status: 0 },
        },
      ],
    })),
  },
  '/api/v1/device/input/sources': [
    {
      id: 512,
      name: 'HDMI 1',
      type: 3,
      sourceStatus: 1,
      usable: true,
      actualResolution: { width: 3840, height: 2160 },
      actualRefreshRate: 50,
    },
    // Disconnected, and still reporting a resolution: the EDID default.
    {
      id: 768,
      name: 'DP 1',
      type: 5,
      sourceStatus: 0,
      usable: true,
      actualResolution: { width: 3840, height: 3840 },
      actualRefreshRate: 60,
    },
  ],
}

describe('the shapes a real MX40 Pro returns', () => {
  it('takes cabinet identity and temperature from the receiving card', async () => {
    const reading = await new CoexReader('10.0.30.11', fakeIo(OBSERVED)).poll()
    expect(reading.cabinets.map((c) => c.id)).toEqual(CAB_IDS.map(String))
    expect(reading.cabinets.map((c) => c.temperature)).toEqual([39, 41, 37])
    expect(reading.cabinets.every((c) => c.online)).toBe(true)
  })

  it('calls a rostered cabinet that did not report offline, rather than dropping it', async () => {
    const routes = structuredClone(OBSERVED) as typeof OBSERVED
    routes['/api/v1/device/monitor/info'].cabinets.splice(1, 1)
    const reading = await new CoexReader('10.0.30.11', fakeIo(routes)).poll()
    expect(reading.cabinets.map((c) => [c.id, c.online])).toEqual([
      [String(CAB_IDS[0]), true],
      [String(CAB_IDS[1]), false],
      [String(CAB_IDS[2]), true],
    ])
  })

  it('reads signal from sourceStatus, and never from the resolution', async () => {
    const reading = await new CoexReader('10.0.30.11', fakeIo(OBSERVED)).poll()
    expect(reading.inputs).toEqual([
      { id: '512', name: 'HDMI 1', connector: 'HDMI 2.0', signal: 'present' },
      { id: '768', name: 'DP 1', connector: 'DP 1.2', signal: 'not-connected' },
    ])
  })

  it('identifies the controller from monitor/info when /api/v1/device is absent', async () => {
    const reading = await new CoexReader('10.0.30.11', fakeIo(OBSERVED)).poll()
    expect(reading.errors).toContain('/api/v1/device answered 404')
    expect(reading.reportedName).toBe('MX40 Pro_000001')
    expect(reading.model).toBe('MX40 Pro')
    expect(reading.snmpEnabled).toBe(false)
  })

  it('does not let monitor/info override a device endpoint that answered', async () => {
    const routes = { ...OBSERVED, '/api/v1/device': { model: 'MX30', name: 'Side wall' } }
    const reading = await new CoexReader('10.0.30.11', fakeIo(routes)).poll()
    expect(reading.model).toBe('MX30')
    expect(reading.reportedName).toBe('Side wall')
  })

  it('reads the main-board temperature and fan rpm from where they are', async () => {
    const reading = await new CoexReader('10.0.30.11', fakeIo(OBSERVED)).poll()
    expect(reading.temperature).toBe(42)
    expect(reading.fanRpm).toBe(2785)
    expect(reading.fanSpeed).toBeUndefined() // rpm is not a percentage
  })

  it('keeps numeric ids as their digits', () => {
    expect(parseCabinets([{ id: 42 }])[0].id).toBe('42')
    expect(parseInputs([{ id: 512 }])[0].id).toBe('512')
  })

  it('reads a { value } object as a reading and a bare number as before', () => {
    expect(parseCabinets([{ id: 'A', temperature: sensor(39) }])[0].temperature).toBe(39)
    expect(parseCabinets([{ id: 'B', temperature: 40 }])[0].temperature).toBe(40)
  })

  it('takes the model from the name suffix, and nothing from a plain name', () => {
    expect(modelFromName('MX40 Pro_000001')).toBe('MX40 Pro')
    expect(modelFromName('Main wall')).toBeUndefined()
    expect(modelFromName(undefined)).toBeUndefined()
  })
})
