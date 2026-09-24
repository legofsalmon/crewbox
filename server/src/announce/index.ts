import { networkInterfaces } from 'node:os'
import { Announcer, type AnnouncerOptions, type ServiceDetails } from './responder.ts'

/**
 * Whether, and where, the box announces itself (see ./responder.ts).
 *
 * The rule the watchers live by is that crewbox never transmits on a
 * production network (docs/NETWATCH.md). The announcer transmits, so it goes
 * only where that rule cannot be in question: the crew adapter, when the box
 * knows which one that is, and in the automatic setting not when a watcher
 * is listening there too, because then the crew network is also the
 * lighting or the audio network. An admin whose crew and show share one
 * network on purpose can say Always.
 *
 * Quiet is a normal state, never an error: a box that does not announce
 * itself still works, the crew type its address or scan its QR as before,
 * and the admin panel says why it is quiet.
 */

/** Stored under this setting. Reaches real boxes: do not rename it. */
export const ANNOUNCE_KEY = 'announce'

export const ANNOUNCE_SETTINGS = ['auto', 'on', 'off'] as const

export type AnnounceSetting = (typeof ANNOUNCE_SETTINGS)[number]

/** `CREWBOX_ANNOUNCE`, where set, wins over what the panel saved. */
export function parseAnnounceSetting(value: string | undefined): AnnounceSetting | undefined {
  const v = value?.trim().toLowerCase()
  if (!v) return undefined
  if (v === 'auto') return 'auto'
  if (['1', 'on', 'true', 'yes', 'always'].includes(v)) return 'on'
  if (['0', 'off', 'false', 'no', 'never'].includes(v)) return 'off'
  return undefined
}

export interface Adapter {
  name: string
  address: string
  netmask: string
}

/** The box's IPv4 adapters: the ones lanAdapters lists, with their netmasks. */
export function crewCandidates(interfaces = networkInterfaces()): Adapter[] {
  const out: Adapter[] = []
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal && !addr.address.startsWith('169.254.')) {
        out.push({ name, address: addr.address, netmask: addr.netmask })
      }
    }
  }
  return out
}

/**
 * A listener on one of the show's networks: the lighting listener, the
 * media watchers, the LED wall scan. `iface` is the adapter it was pointed
 * at, and empty when it was left to the operating system, which may well
 * pick the crew adapter: on a box with one adapter it can pick nothing else.
 */
export interface Watcher {
  /** How the panel names it, as in "because the … is on the crew network too". */
  what: string
  iface: string
}

export interface AnnounceInputs {
  setting: AnnounceSetting
  /** The crew adapter's address as pinned (CREWBOX_IFACE or saved), or ''. */
  crewIface: string
  adapters: Adapter[]
  watchers: Watcher[]
}

export type AnnounceDecision =
  { announce: true; adapter: Adapter } | { announce: false; off: boolean; reason: string }

/** Where to announce, or why not, in words an admin can act on. */
export function decideAnnounce(inputs: AnnounceInputs): AnnounceDecision {
  if (inputs.setting === 'off') {
    return {
      announce: false,
      off: true,
      reason: 'Turned off, so phones have to be given the address.',
    }
  }
  const quiet = (reason: string): AnnounceDecision => ({ announce: false, off: false, reason })

  let adapter: Adapter | undefined
  if (inputs.crewIface) {
    adapter = inputs.adapters.find((a) => a.address === inputs.crewIface)
    if (!adapter) {
      return quiet(
        `The crew network is set to ${inputs.crewIface}, and no adapter has that address right now.`
      )
    }
  } else if (inputs.adapters.length === 1) {
    adapter = inputs.adapters[0]!
  } else if (inputs.adapters.length === 0) {
    return quiet('The box is not on a network yet.')
  } else {
    return quiet(
      `The box is on ${inputs.adapters.length} networks and none is set as the crew network, so it would not know which one to announce itself on. Choose the crew network above.`
    )
  }

  if (inputs.setting === 'auto') {
    for (const watcher of inputs.watchers) {
      if (!watcher.iface || watcher.iface === adapter.address) {
        return quiet(
          watcher.iface
            ? `Quiet, because the ${watcher.what} is on the crew network too, and the box does not transmit on a show network unless told to. Choose Always to announce it there anyway.`
            : `Quiet, because the ${watcher.what} has no adapter set, so it may be on the crew network, and the box does not transmit on a show network unless told to. Give the ${watcher.what} its adapter, or choose Always to announce it anyway.`
        )
      }
    }
  }
  return { announce: true, adapter }
}

export type AnnounceState = 'announcing' | 'starting' | 'quiet' | 'off' | 'failed'

const stopped = (error: string | null): string =>
  `The announcement stopped (${error ?? 'no reason given'}). Trying again.`

export interface AnnounceStatus {
  state: AnnounceState
  setting: AnnounceSetting
  /** Whether CREWBOX_ANNOUNCE decides it, so the panel does not offer the choice. */
  fromEnv: boolean
  /** Why it is quiet, off or failed. */
  reason?: string
  /** Where it is announcing. */
  address?: string
  adapter?: string
  /** The name phones list it under. */
  name?: string
}

/** The part of Announcer the supervisor uses; a stand-in in tests. */
export interface AnnouncerLike {
  readonly state: string
  readonly instanceName: string
  /** What ended it after it started, if something did. */
  readonly error: string | null
  start(): Promise<void>
  refresh(): void
  stop(): Promise<void>
}

export interface AnnouncementsOptions {
  /** The setting as it stands: the environment's, or the saved one. */
  setting: () => AnnounceSetting
  fromEnv: boolean
  /** The crew adapter the box booted with (boot.iface), or ''. */
  crewIface: string
  watchers: Watcher[]
  port: number
  details: () => ServiceDetails
  interfaces?: () => ReturnType<typeof networkInterfaces>
  log?: { info: (msg: string) => void; warn: (msg: string) => void }
  createAnnouncer?: (options: AnnouncerOptions) => AnnouncerLike
  /** How often adapters are looked at again: a cable or a Wi-Fi can come and go. */
  intervalMs?: number
}

/**
 * Keeps one announcer running on the right adapter, or none.
 *
 * Looked at again every fifteen seconds and whenever a setting changes: an
 * adapter that comes up after boot gets the box announced on it, one that
 * goes takes the announcement with it, and a socket that failed is tried
 * again rather than given up on.
 */
export class Announcements {
  private readonly options: AnnouncementsOptions
  private current: { announcer: AnnouncerLike; adapter: Adapter; said: string } | null = null
  private decision: AnnounceDecision | null = null
  private failure: string | null = null
  private timer: NodeJS.Timeout | null = null
  private running = false
  /** One evaluation at a time: starting and stopping sockets is not instant. */
  private busy: Promise<void> = Promise.resolve()

  constructor(options: AnnouncementsOptions) {
    this.options = options
  }

  start(): void {
    if (this.running) return
    this.running = true
    void this.evaluate()
    this.timer = setInterval(() => void this.evaluate(), this.options.intervalMs ?? 15_000)
    this.timer.unref?.()
  }

  /**
   * Something it says may have changed (the event's name, the setting).
   * Resolves once the change has been acted on.
   */
  refresh(): Promise<void> {
    return this.evaluate(true)
  }

  /** Goodbye on the network, and stop looking. */
  async stop(): Promise<void> {
    this.running = false
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.busy
    await this.halt()
  }

  status(): AnnounceStatus {
    const base = { setting: this.options.setting(), fromEnv: this.options.fromEnv }
    const decision = this.decision
    if (!decision) return { ...base, state: 'starting' }
    if (!decision.announce) {
      return { ...base, state: decision.off ? 'off' : 'quiet', reason: decision.reason }
    }
    const where = { address: decision.adapter.address, adapter: decision.adapter.name }
    const running = this.current?.announcer
    if (running?.state === 'announced') {
      return { ...base, ...where, state: 'announcing', name: running.instanceName }
    }
    if (running?.state === 'failed') {
      return { ...base, ...where, state: 'failed', reason: stopped(running.error) }
    }
    if (this.failure) return { ...base, ...where, state: 'failed', reason: this.failure }
    return { ...base, ...where, state: 'starting' }
  }

  private evaluate(changed = false): Promise<void> {
    this.busy = this.busy.then(() => this.step(changed)).catch(() => {})
    return this.busy
  }

  private async step(changed: boolean): Promise<void> {
    if (!this.running) return
    const decision = decideAnnounce({
      setting: this.options.setting(),
      crewIface: this.options.crewIface,
      adapters: crewCandidates(this.options.interfaces?.() ?? networkInterfaces()),
      watchers: this.options.watchers,
    })
    this.decision = decision

    if (!decision.announce) {
      await this.halt()
      this.failure = null
      return
    }
    const current = this.current
    if (current?.announcer.state === 'failed') this.failed(stopped(current.announcer.error))
    if (current?.announcer.state === 'announced' && this.failure) {
      // Only now, with packets actually going out: an announcer that opens
      // its port and then cannot send is not back.
      this.options.log?.info('bonjour: announcing again')
      this.failure = null
    }
    const same =
      current &&
      current.adapter.address === decision.adapter.address &&
      current.adapter.netmask === decision.adapter.netmask
    if (same && current.announcer.state !== 'failed') {
      // Renamed, set up, updated: said again within one look, whether or
      // not whoever changed it remembered to ask.
      const said = JSON.stringify(this.options.details())
      if (changed || said !== current.said) {
        current.said = said
        current.announcer.refresh()
      }
      return
    }
    await this.halt()

    const create = this.options.createAnnouncer ?? ((o) => new Announcer(o))
    const announcer = create({
      address: decision.adapter.address,
      netmask: decision.adapter.netmask,
      port: this.options.port,
      details: this.options.details,
      ...(this.options.log ? { log: this.options.log } : {}),
    })
    this.current = {
      announcer,
      adapter: decision.adapter,
      said: JSON.stringify(this.options.details()),
    }
    try {
      await announcer.start()
    } catch (err) {
      this.failed(
        `Could not open the announcement port (${err instanceof Error ? err.message : String(err)}). Trying again.`
      )
      this.current = null
    }
  }

  /** Said once, not every fifteen seconds for the rest of the event. */
  private failed(reason: string): void {
    if (reason !== this.failure) this.options.log?.warn(`bonjour: ${reason}`)
    this.failure = reason
  }

  private async halt(): Promise<void> {
    const current = this.current
    this.current = null
    if (current) await current.announcer.stop()
  }
}
