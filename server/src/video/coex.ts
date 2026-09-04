import {
  COEX_HTTP_PORT,
  type CabinetReading,
  type DisplayMode,
  type InputReading,
  type InputSignal,
  type ProcessorReading,
} from '@crewbox/shared'

/**
 * The COEX HTTP API on port 8001, read-only by type.
 *
 * `ReadOnlyInit.method` is the literal `'GET'`, so there is no assignment
 * anywhere in this file — or in any file that uses `CoexIo` — that produces
 * another verb. That is deliberately stronger than a runtime check: a future
 * change that wants to blackout a screen has to change this type first, which
 * is a conversation rather than a diff nobody notices. The io adapter checks
 * again at runtime for the same reason the DMX sockets have `send` removed —
 * a promise the compiler keeps is worth more than one a document makes.
 *
 * NovaStar's API has no authentication and no session (the manual says so),
 * which is why nothing here holds credentials: there are none to hold.
 *
 * Provenance: endpoint paths are OFFICIAL, from NovaStar's manual and
 * published clients. **Response field names are not verified against
 * firmware.** Every read below therefore tries the spellings the manual and
 * the published clients use, and leaves the field undefined when none match,
 * rather than guessing. See docs/VIDEO_MONITORING.md.
 */

export interface ReadOnlyInit {
  /** Literal, not `string`. The compiler is the guard. */
  method: 'GET'
  /**
   * Literal, and not the default.
   *
   * `fetch` follows redirects unless told not to, which quietly hands the
   * choice of destination to whatever answered. A host at the address an
   * admin typed can reply `302 Location: http://<processor>:5200/` and the
   * box will open TCP to the register bus and write an HTTP request into it,
   * every twenty seconds — the one thing this module must never do, reached
   * without a single line of this file being wrong. Reproduced on this Node
   * against a listener standing in for the bus.
   */
  redirect: 'error'
  signal: AbortSignal
}

/**
 * Refuse anything that is not a plain read of the COEX API.
 *
 * The comment at the top of this file has always said the adapter re-checks
 * at runtime. It did not — the real one was `fetch(url, init)` — so the type
 * was the only guard and a type is no guard at all against a redirect, which
 * is a decision made by the far end after the type has done its work.
 *
 * The port is the important one. A GET is harmless wherever it lands; a TCP
 * connection to 5200 is not, because that session is one NovaLCT may hold
 * exclusively and taking it could take the desk away from the operator using
 * it mid-show. So this refuses on the port, before a socket is opened, and
 * `readOnlyFetch` is the only way out of this module.
 */
export function assertReadOnly(url: string, init: ReadOnlyInit, port = COEX_HTTP_PORT): void {
  if (init.method !== 'GET') throw new Error(`video is read-only: refusing ${init.method}`)
  if (init.redirect !== 'error') {
    throw new Error('video is read-only: refusing to follow a redirect')
  }
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:') {
    throw new Error(`video is read-only: refusing ${parsed.protocol}`)
  }
  if (parsed.port !== String(port)) {
    throw new Error(`video is read-only: refusing a request to port ${parsed.port || '80'}`)
  }
}

export interface CoexResponse {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}

export interface CoexIo {
  fetch: (url: string, init: ReadOnlyInit) => Promise<CoexResponse>
  now: () => number
  /** Injectable so tests never sleep. */
  wait: (ms: number) => Promise<void>
}

/** The COEX "device is busy with something else" code. Back off, don't retry. */
export const BUSY_CODE = 5

/** Gap between requests, so a poll is a trickle rather than a burst. */
export const REQUEST_GAP_MS = 200

/** How long a `Busying` answer pushes the next request out. */
export const BUSY_BACKOFF_MS = 5_000

/** Per-request ceiling. A processor that is thinking is not a processor to wait for. */
export const REQUEST_TIMEOUT_MS = 4_000

/**
 * Re-read topology every Nth poll.
 *
 * Cabinet layout, screen list and identity change when somebody re-patches
 * the wall, which is a between-sets event, not a per-second one. Status is
 * the part that moves.
 */
export const TOPOLOGY_EVERY = 10

/** Endpoints, split by how often they are worth asking. OFFICIAL paths. */
export const STATUS_ENDPOINTS = [
  '/api/v1/device/monitor/info',
  '/api/v1/device/screen/displaymode',
  '/api/v1/device/input/sources',
  '/api/v1/device/backup',
] as const

export const TOPOLOGY_ENDPOINTS = [
  '/api/v1/device',
  '/api/v1/device/cabinet',
  '/api/v1/screen',
  '/api/v1/device/snmpstate',
] as const

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Read one of several candidate spellings.
 *
 * The manual, the published clients and `coexsim` do not agree on case, so a
 * reader that insists on one spelling reports a healthy wall as silent. This
 * is the "code defensively" half of the provenance note above.
 */
function pick(obj: unknown, keys: string[]): unknown {
  if (!isObject(obj)) return undefined
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key]
  }
  return undefined
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined

const bool = (v: unknown): boolean | undefined => {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (v === 'true' || v === 'false') return v === 'true'
  return undefined
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** Unwrap `{ code, data }` when present. Returns null on a `Busying` answer. */
export function unwrap(payload: unknown): { data: unknown; busy: boolean } {
  if (!isObject(payload)) return { data: payload, busy: false }
  const code = num(pick(payload, ['code', 'errorCode', 'ret']))
  if (code === BUSY_CODE) return { data: null, busy: true }
  const data = pick(payload, ['data', 'result'])
  return { data: data === undefined ? payload : data, busy: false }
}

const SIGNAL_BY_CODE: Record<number, InputSignal> = {
  0: 'not-connected',
  1: 'present',
  2: 'no-signal',
}

const MODE_BY_CODE: Record<number, DisplayMode> = {
  0: 'normal',
  1: 'blackout',
  2: 'freeze',
}

/**
 * Blackout and freeze are swapped between the COEX API and the VX4S register
 * map (novasun's `CLAUDE.md` flags it as a thing that bites). This module only
 * ever speaks COEX, so this table is the COEX one and the other never applies
 * here — but naming it stops somebody "fixing" it against the wrong reference.
 */
export function displayModeOf(value: unknown): DisplayMode | undefined {
  const code = num(value)
  if (code !== undefined) return MODE_BY_CODE[code]
  const name = str(value)?.toLowerCase()
  if (name === 'normal' || name === 'blackout' || name === 'freeze') return name
  return undefined
}

export function parseCabinets(payload: unknown): CabinetReading[] {
  const list = arr(pick(payload, ['cabinets', 'cabinetList', 'list', 'items']) ?? payload)
  const out: CabinetReading[] = []
  for (const [index, raw] of list.entries()) {
    if (!isObject(raw)) continue
    const id = str(pick(raw, ['id', 'cabinetId', 'sn', 'serialNumber'])) ?? String(index + 1)
    // Not `status`: it is a *code* everywhere else in this API — an input's
    // signal status is 0 not-connected, 1 present, 2 no-signal — and `bool`
    // turns 0 into false, so a firmware reporting `status: 0` for a normal
    // cabinet painted a working wall red. A cabinet that only says `status`
    // now falls through to the module's own default for "the firmware
    // didn't say", which is online.
    const online = bool(pick(raw, ['online', 'isOnline', 'connected']))
    out.push({
      id,
      ...(str(pick(raw, ['screen', 'screenId', 'screenName'])) !== undefined
        ? { screen: str(pick(raw, ['screen', 'screenId', 'screenName'])) }
        : {}),
      // Absent means the firmware didn't say, and a cabinet that didn't say
      // is not the same as one that said it was down. Default to online so a
      // sparse payload doesn't paint a working wall red.
      online: online ?? true,
      ...(num(pick(raw, ['temperature', 'temp', 'tempValue'])) !== undefined
        ? { temperature: num(pick(raw, ['temperature', 'temp', 'tempValue'])) }
        : {}),
    })
  }
  return out
}

export function parseInputs(payload: unknown): InputReading[] {
  const list = arr(pick(payload, ['sources', 'inputs', 'list', 'items']) ?? payload)
  const out: InputReading[] = []
  for (const [index, raw] of list.entries()) {
    if (!isObject(raw)) continue
    const code = num(pick(raw, ['signalStatus', 'signal', 'status']))
    const connected = bool(pick(raw, ['connected', 'isConnected']))
    const signal: InputSignal =
      code !== undefined && SIGNAL_BY_CODE[code] !== undefined
        ? SIGNAL_BY_CODE[code]
        : connected === true
          ? 'present'
          : 'not-connected'
    out.push({
      id: str(pick(raw, ['id', 'sourceId', 'index'])) ?? String(index + 1),
      ...(str(pick(raw, ['name', 'sourceName', 'label'])) !== undefined
        ? { name: str(pick(raw, ['name', 'sourceName', 'label'])) }
        : {}),
      ...(str(pick(raw, ['type', 'connector', 'connectorType', 'interfaceType'])) !== undefined
        ? { connector: str(pick(raw, ['type', 'connector', 'connectorType', 'interfaceType'])) }
        : {}),
      signal,
    })
  }
  return out
}

/**
 * Reads one processor over HTTP.
 *
 * Never throws. An endpoint that 404s, times out or answers something
 * unexpected lands in `errors` and the rest of the poll continues — a
 * firmware that lacks one endpoint should cost that one row, not the pane.
 */
export class CoexReader {
  private readonly io: CoexIo
  private readonly base: string
  private polls = 0
  private nextAllowedAt = 0
  /** Last good topology, so a status-only poll still renders a full row. */
  private topology: Partial<ProcessorReading> = {}

  constructor(host: string, io: CoexIo, port: number = COEX_HTTP_PORT) {
    this.io = io
    this.base = `http://${host}:${port}`
  }

  /** Whether the last answer asked us to back off. */
  get backingOff(): boolean {
    return this.io.now() < this.nextAllowedAt
  }

  private async get(path: string): Promise<{ data: unknown; error?: string }> {
    const wait = this.nextAllowedAt - this.io.now()
    if (wait > 0) await this.io.wait(wait)
    this.nextAllowedAt = this.io.now() + REQUEST_GAP_MS

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const res = await this.io.fetch(`${this.base}${path}`, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
      })
      if (!res.ok) return { data: null, error: `${path} answered ${res.status}` }
      const payload: unknown = await res.json()
      const { data, busy } = unwrap(payload)
      if (busy) {
        this.nextAllowedAt = this.io.now() + BUSY_BACKOFF_MS
        return { data: null, error: `${path} was busy` }
      }
      return { data }
    } catch (err) {
      const why = err instanceof Error && err.name === 'AbortError' ? 'timed out' : 'no answer'
      return { data: null, error: `${path} ${why}` }
    } finally {
      clearTimeout(timer)
    }
  }

  async poll(): Promise<ProcessorReading> {
    const errors: string[] = []
    const wantTopology = this.polls % TOPOLOGY_EVERY === 0
    this.polls++

    /**
     * Endpoints that answered *this* poll.
     *
     * Load-bearing, and the cached topology below is why. Without it a
     * processor that has been unplugged keeps answering with its last known
     * model and cabinet list — every poll looks like a reading, the caller
     * never counts a miss, and the pane shows a wall that is no longer there
     * as healthy. Cached topology is only worth merging into a reading that
     * got something.
     */
    let answered = 0

    const reading: ProcessorReading = {
      at: this.io.now(),
      readPath: 'http',
      cabinets: [],
      inputs: [],
      errors,
    }

    if (wantTopology) {
      const fresh: Partial<ProcessorReading> = {}
      const device = await this.get('/api/v1/device')
      if (device.error) errors.push(device.error)
      else {
        answered++
        const model = str(pick(device.data, ['model', 'deviceModel', 'productName']))
        const name = str(pick(device.data, ['name', 'deviceName', 'alias']))
        const serial = str(pick(device.data, ['sn', 'serial', 'serialNumber']))
        const firmware = str(pick(device.data, ['version', 'firmware', 'firmwareVersion']))
        if (model) fresh.model = model
        if (name) fresh.reportedName = name
        if (serial) fresh.serial = serial
        if (firmware) fresh.firmware = firmware
      }

      const cabinet = await this.get('/api/v1/device/cabinet')
      if (cabinet.error) errors.push(cabinet.error)
      else {
        answered++
        fresh.cabinets = parseCabinets(cabinet.data)
      }

      const screen = await this.get('/api/v1/screen')
      if (screen.error) errors.push(screen.error)
      else {
        answered++
        const first = arr(pick(screen.data, ['screens', 'list', 'items']) ?? screen.data)[0]
        const brightness = num(pick(first, ['brightness', 'brightnessValue', 'lightness']))
        if (brightness !== undefined) fresh.brightness = brightness
      }

      // Asked last and kept whatever the answer is: "SNMP is off" is a state
      // the pane shows, not an error, because switching it on is a write.
      const snmp = await this.get('/api/v1/device/snmpstate')
      if (snmp.error) errors.push(snmp.error)
      else {
        answered++
        const on = bool(pick(snmp.data, ['enable', 'enabled', 'state', 'snmpState']))
        if (on !== undefined) fresh.snmpEnabled = on
      }

      // Only replace the cache when this poll learned something. A sweep in
      // which every topology endpoint failed must not erase what we knew.
      if (answered > 0) this.topology = fresh
    }

    const monitor = await this.get('/api/v1/device/monitor/info')
    if (monitor.error) errors.push(monitor.error)
    else {
      answered++
      const temp = num(pick(monitor.data, ['temperature', 'temp', 'deviceTemperature']))
      const fan = num(pick(monitor.data, ['fanSpeed', 'fan', 'fanSpeedPercent']))
      if (temp !== undefined) reading.temperature = temp
      if (fan !== undefined) reading.fanSpeed = fan
      // Per-cabinet monitoring is the live half; the cabinet endpoint gives
      // the layout. Prefer whatever this poll actually saw.
      const cabinets = parseCabinets(pick(monitor.data, ['cabinets', 'cabinetList']) ?? [])
      if (cabinets.length > 0) reading.cabinets = cabinets
    }

    const mode = await this.get('/api/v1/device/screen/displaymode')
    if (mode.error) errors.push(mode.error)
    else {
      answered++
      const value = displayModeOf(pick(mode.data, ['mode', 'displayMode', 'value']) ?? mode.data)
      if (value) reading.displayMode = value
    }

    const inputs = await this.get('/api/v1/device/input/sources')
    if (inputs.error) errors.push(inputs.error)
    else {
      answered++
      reading.inputs = parseInputs(inputs.data)
    }

    const backup = await this.get('/api/v1/device/backup')
    if (backup.error) errors.push(backup.error)
    else {
      answered++
      const role = pick(backup.data, ['isBackup', 'backup', 'role', 'status'])
      const asBool = bool(role)
      if (asBool !== undefined) reading.isBackup = asBool
      else if (num(role) !== undefined) reading.isBackup = num(role) === 1
    }

    reading.answered = answered
    // Nothing answered: an empty reading, with no cached identity dressing it
    // up as a live one. The caller counts this as a miss.
    if (answered === 0) return reading

    // Fill the gaps a status-only poll leaves — identity and layout — from
    // the last sweep that did read them, without letting them overwrite
    // anything this poll saw for itself.
    for (const [key, value] of Object.entries(this.topology)) {
      if (reading[key as keyof ProcessorReading] === undefined) {
        Object.assign(reading, { [key]: value })
      }
    }
    if (reading.cabinets.length === 0 && this.topology.cabinets) {
      reading.cabinets = this.topology.cabinets
    }
    return reading
  }
}

/**
 * True when a poll got nothing at all — every endpoint failed.
 *
 * The distinction matters: a processor answering four of six endpoints is
 * being watched with gaps, while one answering none is not there. Only the
 * second is worth telling somebody about.
 */
export function readingIsEmpty(reading: ProcessorReading): boolean {
  // The count when the reader kept one — "did anything answer" is the
  // question, and it is not the same as "did we recognise any of it".
  if (reading.answered !== undefined) return reading.answered === 0
  return (
    reading.cabinets.length === 0 &&
    reading.inputs.length === 0 &&
    reading.model === undefined &&
    reading.temperature === undefined &&
    reading.displayMode === undefined
  )
}
