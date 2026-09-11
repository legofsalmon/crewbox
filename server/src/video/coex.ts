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

/**
 * Consecutive 404s before an endpoint is taken as absent from the firmware.
 *
 * Three of the eight endpoints below answer 404 on an MX40 Pro (OBSERVED):
 * `/api/v1/device`, `/api/v1/device/audio`, and — by the conservative reading
 * — the two never requested on it. That is a property of the firmware, not a
 * fault: it answers the same way for the length of the show. Asking anyway
 * puts three requests per poll on the video network for an answer nobody
 * needs, and reports three failures under a wall that is working.
 *
 * More than one, because a single 404 can be a controller rebooting into a
 * partly-answering state, and a firmware that grows an endpoint across an
 * update should be found again by the next box restart rather than never.
 */
export const ABSENT_AFTER = 3

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

/**
 * A number the firmware may have wrapped in a reading object.
 *
 * **Every monitoring value on a real COEX controller is
 * `{ name, nameEn, status, value }`, never a bare number** — OBSERVED on an
 * MX40 Pro, and novasun records that a reader which assumed otherwise crashed
 * its refresh thread on first contact. This one didn't crash; `num()` simply
 * returned undefined for an object, so the controller temperature, the
 * mainboard voltage and every per-cabinet reading came back blank from a wall
 * that was reporting all of them.
 *
 * `status` sits beside `value` in that object and is not read here: novasun
 * has the codes as UNKNOWN, and a working card carries `errorBit[0].status: 1`
 * while a working fan carries `status: 0`, so there is no reading of it that
 * is better than not guessing.
 */
const metric = (v: unknown): number | undefined => (isObject(v) ? num(pick(v, ['value'])) : num(v))

/**
 * An id the firmware may report as text or as a 64-bit number.
 *
 * `/api/v1/device/cabinet` reports `id: 700000000000001` — a number, and the
 * receiving card's real serial. `str()` rejected it, so every cabinet fell
 * through to its list position instead, which is the one thing a cabinet id
 * must not be on this hardware (see `parseCabinets`).
 */
const idOf = (v: unknown): string | undefined => {
  const s = str(v)
  if (s !== undefined) return s
  const n = num(v)
  return n !== undefined && Number.isInteger(n) ? String(n) : undefined
}

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

/**
 * Cabinet identity, and why it is worth this much care.
 *
 * `monitor/info` returns its cabinets **in a different order on every call** —
 * OBSERVED, all 288 of them moved between two reads 35 minutes apart, with
 * the same ids and the same per-id readings. So a cabinet identified by its
 * list position is a label that stays still while the hardware behind it
 * rotates: "cabinet 3" is a different panel each poll, and anything trending
 * a temperature or holding an alert against it is following whatever happens
 * to be third in the array.
 *
 * The ids are therefore taken from the payload wherever the payload has them,
 * and position is the last resort. When the firmware's own ids don't tell the
 * cabinets apart — `monitor/info.cabinets[].cabinetID` is `0` on every
 * cabinet, OBSERVED — the *whole list* falls back to position rather than
 * some rows keeping a useless id and others not. One rule for the list, so a
 * caller can tell which it got by looking at the first row.
 */
function cabinetIds(list: unknown[]): (string | undefined)[] {
  const ids = list.map((raw) =>
    idOf(pick(raw, ['id', 'cabinetID', 'cabinetId', 'sn', 'serialNumber']))
  )
  const named = ids.filter((v): v is string => v !== undefined)
  if (named.length !== list.length || new Set(named).size !== named.length) {
    return list.map(() => undefined)
  }
  return ids
}

export function parseCabinets(payload: unknown): CabinetReading[] {
  const list = arr(pick(payload, ['cabinets', 'cabinetList', 'list', 'items']) ?? payload).filter(
    (raw) => isObject(raw)
  )
  const ids = cabinetIds(list)
  const out: CabinetReading[] = []
  for (const [index, raw] of list.entries()) {
    // Not `status`: it is a *code* everywhere else in this API — an input's
    // signal status is 0 not-connected, 1 present, 2 no-signal — and `bool`
    // turns 0 into false, so a firmware reporting `status: 0` for a normal
    // cabinet painted a working wall red. A cabinet that only says `status`
    // now falls through to the module's own default for "the firmware
    // didn't say", which is online.
    const online = bool(pick(raw, ['online', 'isOnline', 'connected']))
    out.push({
      id: ids[index] ?? String(index + 1),
      ...(str(pick(raw, ['screen', 'screenId', 'screenName'])) !== undefined
        ? { screen: str(pick(raw, ['screen', 'screenId', 'screenName'])) }
        : {}),
      // Absent means the firmware didn't say, and a cabinet that didn't say
      // is not the same as one that said it was down. Default to online so a
      // sparse payload doesn't paint a working wall red — but say which it
      // was, because a wall that is online only by default is not a wall
      // anybody has been told is healthy. See `CabinetReading.onlineAssumed`.
      online: online ?? true,
      ...(online === undefined ? { onlineAssumed: true } : {}),
      ...(metric(pick(raw, ['temperature', 'temp', 'tempValue'])) !== undefined
        ? { temperature: metric(pick(raw, ['temperature', 'temp', 'tempValue'])) }
        : {}),
    })
  }
  return out
}

/**
 * The live half of the wall, which lives one level deeper than it looks.
 *
 * `monitor/info.cabinets[]` is a list of *outputs*, not of panels: its own
 * `cabinetID` is 0 and its own temperature and voltage read 0. The readings
 * are on the receiving cards inside it, and `rvCards[].cabinetID` is the
 * 64-bit id that joins to `/api/v1/device/cabinet` — 288 of 288 on the one
 * unit this has been checked against. All OBSERVED.
 *
 * So flatten: one `CabinetReading` per receiving card, keyed on the card's
 * own id. A firmware that reports cabinets the flat way — `coexsim`, and
 * every payload in `videoCoex.test.ts` — has no `rvCards` and goes through
 * `parseCabinets` unchanged.
 */
export function parseMonitorCabinets(payload: unknown): CabinetReading[] {
  const list = arr(pick(payload, ['cabinets', 'cabinetList']) ?? [])
  const cards = list.flatMap((raw) => arr(pick(raw, ['rvCards'])).filter((c) => isObject(c)))
  if (cards.length === 0) return parseCabinets(payload)

  const ids = cabinetIds(cards)
  return cards.map((card, index) => {
    const temperature = metric(pick(card, ['temperature']))
    return {
      id: ids[index] ?? String(index + 1),
      // A reporting card is the working definition of online here, because
      // this firmware has no flag for it and expresses "offline" by leaving
      // the cabinet out of the list entirely. `CoexReader.poll` is where that
      // absence gets noticed, against the stable cabinet list.
      online: true,
      onlineAssumed: true,
      ...(temperature !== undefined ? { temperature } : {}),
    }
  })
}

export function parseInputs(payload: unknown): InputReading[] {
  const list = arr(pick(payload, ['sources', 'inputs', 'list', 'items']) ?? payload)
  const out: InputReading[] = []
  for (const [index, raw] of list.entries()) {
    if (!isObject(raw)) continue
    // `sourceStatus` first, because that is the one a real controller uses —
    // OBSERVED: 1 on the inputs feeding the show, 0 elsewhere, which is the
    // same 0/1/2 enumeration SNMP publishes. Reading only the manual's
    // `signalStatus` made every input on a live wall report not-connected,
    // HDMI 1 included, while it was carrying the show.
    //
    // `usable` is deliberately *not* consulted. It reads `true` on inputs with
    // no signal as well as on live ones, so taking it for connectivity would
    // walk straight back into the same wrong answer from the other side. A
    // disconnected input also still reports a resolution — that is the EDID
    // default, not evidence of a source.
    const code = num(pick(raw, ['sourceStatus', 'signalStatus', 'signal', 'status']))
    const connected = bool(pick(raw, ['connected', 'isConnected']))
    const signal: InputSignal =
      code !== undefined && SIGNAL_BY_CODE[code] !== undefined
        ? SIGNAL_BY_CODE[code]
        : connected === true
          ? 'present'
          : 'not-connected'
    out.push({
      // `idOf`, not `str`: a real controller reports `id: 512` — a number,
      // and its own identifier for that connector. Falling through to list
      // position is the same trap as the cabinets, one connector wide.
      id: idOf(pick(raw, ['id', 'sourceId', 'index'])) ?? String(index + 1),
      ...(str(pick(raw, ['name', 'sourceName', 'label'])) !== undefined
        ? { name: str(pick(raw, ['name', 'sourceName', 'label'])) }
        : {}),
      // `type` is an int code on a real controller — 3 on an HDMI input, 5 on
      // a DisplayPort one — and nobody has mapped that enumeration. `str()`
      // declines it, which is the right answer and not an oversight: SNMP
      // publishes connector types properly, the input's own name already
      // reads "HDMI 1", and a wrong label on a screen is worse than a blank.
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
  /** Consecutive 404s per endpoint, and what they latch into. */
  private readonly notFound = new Map<string, number>()
  private readonly absent = new Set<string>()

  constructor(host: string, io: CoexIo, port: number = COEX_HTTP_PORT) {
    this.io = io
    this.base = `http://${host}:${port}`
  }

  /** Whether the last answer asked us to back off. */
  get backingOff(): boolean {
    return this.io.now() < this.nextAllowedAt
  }

  private async get(path: string): Promise<{ data: unknown; error?: string; status?: number }> {
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
      if (!res.ok) {
        return { data: null, error: `${path} answered ${res.status}`, status: res.status }
      }
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
     * Re-probe the missing endpoints on every topology sweep.
     *
     * Without this, `absent` is a one-way door: a controller that 404s
     * everything — a reboot part-way up, a firmware that grows an endpoint
     * across an update — would be written off and never asked again for as
     * long as the box ran. Clearing the set here costs one extra request per
     * missing endpoint per ten polls, and the 404 counts are deliberately
     * *not* cleared with it, so an endpoint that is still missing latches
     * again on that same poll rather than serving another three.
     */
    if (wantTopology) this.absent.clear()

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

    /**
     * Ask one endpoint, or don't.
     *
     * Returns `undefined` for every outcome that isn't an answer — a failure,
     * or an endpoint already known to be missing from this firmware — so a
     * caller reads as "if it answered, here is what it said". `answered`
     * counts an answer whatever was in it, which is the distinction
     * `ProcessorReading.answered` exists to keep: a payload we didn't
     * recognise is still a processor at that address.
     */
    const ask = async (path: string): Promise<unknown> => {
      if (this.absent.has(path)) return undefined
      const res = await this.get(path)
      if (res.error !== undefined) {
        if (res.status === 404) {
          const seen = (this.notFound.get(path) ?? 0) + 1
          this.notFound.set(path, seen)
          if (seen >= ABSENT_AFTER) {
            this.absent.add(path)
            return undefined
          }
        }
        errors.push(res.error)
        return undefined
      }
      // It answered, so it exists — whatever it 404'd on before.
      this.notFound.delete(path)
      this.absent.delete(path)
      answered++
      return res.data
    }

    if (wantTopology) {
      const fresh: Partial<ProcessorReading> = {}
      const device = await ask('/api/v1/device')
      if (device !== undefined) {
        const model = str(pick(device, ['model', 'deviceModel', 'productName']))
        const name = str(pick(device, ['name', 'deviceName', 'alias']))
        const serial = str(pick(device, ['sn', 'serial', 'serialNumber']))
        const firmware = str(pick(device, ['version', 'firmware', 'firmwareVersion']))
        if (model) fresh.model = model
        if (name) fresh.reportedName = name
        if (serial) fresh.serial = serial
        if (firmware) fresh.firmware = firmware
      }

      const cabinet = await ask('/api/v1/device/cabinet')
      if (cabinet !== undefined) {
        fresh.cabinets = parseCabinets(cabinet)
        /**
         * Brightness, when the screen didn't carry it.
         *
         * `/api/v1/screen` has no brightness field at all on a real
         * controller (OBSERVED); the cabinets do, **as a 0–1 fraction**.
         * `brightness` is documented as 0–100 and the pane prints a per-cent
         * sign, so 0.8 has to become 80 — but a firmware that reports 0–100
         * here must not be multiplied. A value at or below 1 is a fraction:
         * the alternative reading is a wall dimmed to 1%, which is not a
         * thing anybody runs and is anyway indistinguishable from off.
         */
        const fraction = num(pick(arr(cabinet)[0], ['brightness']))
        if (fraction !== undefined) {
          fresh.brightness = fraction <= 1 ? Math.round(fraction * 100) : fraction
        }
      }

      const screen = await ask('/api/v1/screen')
      if (screen !== undefined) {
        const first = arr(pick(screen, ['screens', 'list', 'items']) ?? screen)[0]
        const brightness = num(pick(first, ['brightness', 'brightnessValue', 'lightness']))
        if (brightness !== undefined) fresh.brightness = brightness
      }

      // Asked last and kept whatever the answer is: "SNMP is off" is a state
      // the pane shows, not an error, because switching it on is a write.
      const snmp = await ask('/api/v1/device/snmpstate')
      if (snmp !== undefined) {
        const on = bool(pick(snmp, ['enable', 'enabled', 'state', 'snmpState']))
        if (on !== undefined) fresh.snmpEnabled = on
      }

      // Only replace the cache when this poll learned something. A sweep in
      // which every topology endpoint failed must not erase what we knew.
      if (answered > 0) this.topology = fresh
    }

    const monitor = await ask('/api/v1/device/monitor/info')
    if (monitor !== undefined) {
      // `mainBoardTemperature` and `fanInfos` are the real spellings, and
      // both wrap their number: see `metric`. The manual's bare `temperature`
      // and `fanSpeed` stay first so `coexsim` and every firmware that does
      // follow the manual keep working.
      const temp = metric(
        pick(monitor, ['temperature', 'temp', 'deviceTemperature', 'mainBoardTemperature'])
      )
      const fan = num(pick(monitor, ['fanSpeed', 'fan', 'fanSpeedPercent']))
      if (temp !== undefined) reading.temperature = temp
      if (fan !== undefined) reading.fanSpeed = fan

      // Fans, the way a controller actually reports them: a list, in rpm.
      // Fastest rather than first — a chassis with several is being asked
      // "is anything working hard", and the busiest one is the answer.
      const speeds = arr(pick(monitor, ['fanInfos']))
        .map((f) => num(pick(f, ['fanSpeed'])))
        .filter((s): s is number => s !== undefined)
      if (speeds.length > 0) reading.fanRpm = Math.max(...speeds)

      // Identity, when `/api/v1/device` isn't there to give it. `name` on a
      // real controller is "MX40 Pro_000001" — its own name for itself, which
      // is exactly what `reportedName` is for. No model is derived from it:
      // splitting that string on an underscore is a guess about a format
      // seen once, and the pane shows the name either way.
      const called = str(pick(monitor, ['name', 'deviceName']))
      if (called !== undefined) reading.reportedName = called

      // Per-cabinet monitoring is the live half; the cabinet endpoint gives
      // the layout. Prefer whatever this poll actually saw.
      const cabinets = parseMonitorCabinets(monitor)
      if (cabinets.length > 0) reading.cabinets = cabinets
    }

    const mode = await ask('/api/v1/device/screen/displaymode')
    if (mode !== undefined) {
      const value = displayModeOf(pick(mode, ['mode', 'displayMode', 'value']) ?? mode)
      if (value) reading.displayMode = value
    }

    const inputs = await ask('/api/v1/device/input/sources')
    if (inputs !== undefined) reading.inputs = parseInputs(inputs)

    const backup = await ask('/api/v1/device/backup')
    if (backup !== undefined) {
      const role = pick(backup, ['isBackup', 'backup', 'role', 'status'])
      const asBool = bool(role)
      if (asBool !== undefined) reading.isBackup = asBool
      else if (num(role) !== undefined) reading.isBackup = num(role) === 1
    }

    reading.answered = answered
    if (this.absent.size > 0) reading.absent = [...this.absent]
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
    // Copied, not shared: a reading goes out to the watcher and the store,
    // and the cache has to survive whatever they do with it — including the
    // append just below.
    if (reading.cabinets.length === 0 && this.topology.cabinets) {
      reading.cabinets = [...this.topology.cabinets]
    }

    /**
     * The cabinet that stopped answering.
     *
     * This firmware has no online flag anywhere, and expresses a cabinet
     * dropping off the chain by **leaving it out of `monitor/info`** — so the
     * count falls from 288 to 287 and nothing else changes. Read on its own,
     * that is invisible: 287 cabinets, all "online", no fault. A screens tech
     * finds out when somebody looks at the wall.
     *
     * `/api/v1/device/cabinet` is the other half. It is the configured
     * layout, it keeps a stable order, and it still lists a panel that has
     * gone quiet — so the ids it has that this poll's monitoring doesn't are
     * the cabinets that are missing, and that is a reported state rather than
     * an assumed one.
     *
     * Guarded on the two lists sharing a namespace at all: if not one live id
     * appears in the layout, these are not the same identifiers and the
     * difference between them means nothing. A firmware that numbers its
     * cabinets one way in one endpoint and another way in the other would
     * otherwise have its entire wall declared offline every poll.
     */
    const known = this.topology.cabinets ?? []
    const live = new Set(reading.cabinets.map((c) => c.id))
    if (known.length > 0 && live.size > 0 && known.some((c) => live.has(c.id))) {
      for (const cabinet of known) {
        if (live.has(cabinet.id)) continue
        reading.cabinets.push({
          id: cabinet.id,
          ...(cabinet.screen !== undefined ? { screen: cabinet.screen } : {}),
          online: false,
        })
      }
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
