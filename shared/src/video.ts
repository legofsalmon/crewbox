/**
 * Video: watching an LED wall, never driving it.
 *
 * A screens tech at a festival wants to know three things from the far side
 * of a field: are all the cabinets talking, is anything cooking, and is there
 * still a signal on the input. Every one of those is answerable by reading,
 * and none of them needs the ability to change what is on the wall.
 *
 * So this module reads and nothing else. There is no encoder anywhere in
 * crewbox that can produce a NovaStar write — not a register write, not an
 * HTTP PUT, not an SNMP SET — and the tests assert their absence rather than
 * their disuse. The protocol facts come from a sister project (`novasun`),
 * which carries the provenance for each one; `docs/VIDEO_MONITORING.md`
 * records what is established and what is still a guess.
 *
 * The one thing that is not free is that reading here means transmitting: a
 * GET is a packet on the video network, unlike the lighting and media
 * listeners which are pure receive. That is why everything that puts a packet
 * on the wire is admin-only and needs a second, separate confirmation step —
 * see `VideoIntent`.
 */

/**
 * How a processor can be read, in the order crewbox prefers.
 *
 * `snmp`  — NovaStar's own monitoring interface. GET is read-only by
 *           construction, and it exposes far more than the HTTP API does:
 *           per-receiving-card temperature and voltage, per-input signal
 *           presence, fan and card health. Needs SNMP switched on at the
 *           controller, which is a write we do not make.
 * `http`  — the COEX API on port 8001. Fewer fields and the response shapes
 *           are provisional, but it needs no setup.
 * `none`  — nothing answered. Either there is no processor at that address,
 *           or it is a model whose only interface is the register bus.
 */
export const VIDEO_READ_PATHS = ['snmp', 'http', 'none'] as const

export type VideoReadPath = (typeof VIDEO_READ_PATHS)[number]

/**
 * What crewbox is doing about a processor right now.
 *
 * `listed` is the resting state and the important one: an address somebody
 * typed in, which the box has never contacted and will not contact until an
 * admin says so. A processor sitting in `listed` generates no traffic at all.
 */
export type ProcessorState = 'listed' | 'watching' | 'unreachable' | 'no-read-path'

/** Health at a glance, for the sidebar dot and the row. */
export type ProcessorHealth = 'ok' | 'warn' | 'fault' | 'unknown'

/**
 * A processor somebody has told the box about.
 *
 * `host` is an address, not a name: discovery identifies a device by the
 * source IP of its reply and nothing else that we can rely on, so the address
 * is the identity. `name` is whatever the crew calls it — "upstage left" —
 * until the processor tells us its own, at which point `reportedName` fills
 * in beside it rather than overwriting what a human chose.
 */
export interface VideoProcessor {
  id: string
  /** Crew's name for it. Never overwritten by anything read off the wire. */
  name: string
  /** IPv4 address. The device's identity, per the note above. */
  host: string
  /**
   * Whether the box may contact it. False until an admin confirms twice;
   * false again the moment anyone turns it off, which needs no confirmation
   * because stopping is not a transmission.
   */
  monitored: boolean
  /** Who added it, and when — this list decides what the box talks to. */
  addedBy: string
  addedAt: number
  /** Who last turned monitoring on, so the traffic has a name against it. */
  armedBy?: string
  armedAt?: number
  /** How it got here: typed in, or found by a confirmed scan. */
  source: 'manual' | 'scan'
}

/** A cabinet's own report. Absent fields mean the firmware didn't say. */
export interface CabinetReading {
  id: string
  /** Screen it belongs to, when the controller groups them. */
  screen?: string
  online: boolean
  /** Degrees Celsius. */
  temperature?: number
  /**
   * SNMP reports receiving cards as normal/abnormal rather than as a number,
   * so a cabinet read that way has a status and no `temperature`. Both are
   * kept rather than flattened: "too hot" and "60°C" are different claims and
   * the pane should not print one as the other.
   */
  tempStatus?: 'normal' | 'abnormal'
}

export type InputSignal = 'present' | 'no-signal' | 'not-connected'

export interface InputReading {
  id: string
  name?: string
  /** DVI, HDMI 2.0, 12G-SDI, ST 2110 … as the controller reports it. */
  connector?: string
  signal: InputSignal
}

/** What the wall is being told to do. Read-back only — crewbox cannot set it. */
export type DisplayMode = 'normal' | 'blackout' | 'freeze'

/**
 * One poll's worth of answers.
 *
 * Every field is optional except `at` and `readPath`, and that is the design:
 * an endpoint the firmware doesn't implement, or a field spelled differently
 * from the manual, leaves a gap rather than failing the poll or inventing a
 * value. `errors` says which endpoints didn't answer so the gap is legible
 * instead of looking like good news.
 */
export interface ProcessorReading {
  at: number
  readPath: VideoReadPath
  model?: string
  reportedName?: string
  serial?: string
  firmware?: string
  /** Controller mainboard temperature, degrees Celsius. */
  temperature?: number
  /** Percent, when the controller reports fans that way. */
  fanSpeed?: number
  /** A fan the controller calls abnormal. SNMP gives status, not a speed. */
  fanFault?: boolean
  /** Cards the controller calls abnormal — receiving, output or input. */
  cardFaults?: number
  /** True when this controller is the backup of a redundant pair. */
  isBackup?: boolean
  displayMode?: DisplayMode
  /** 0–100. Read-back: crewbox has no way to change it. */
  brightness?: number
  cabinets: CabinetReading[]
  inputs: InputReading[]
  /**
   * Whether SNMP is switched on at the controller. Read over HTTP, because
   * it is the one thing worth knowing before deciding how to read everything
   * else. Undefined means we couldn't tell.
   */
  snmpEnabled?: boolean
  /** Endpoints that didn't answer, in words. Never thrown, always shown. */
  errors: string[]
}

/** A processor plus what the box currently knows about it. */
export interface ProcessorStatus {
  processor: VideoProcessor
  state: ProcessorState
  health: ProcessorHealth
  /** Why the health is what it is, in a phrase a screens tech would use. */
  summary: string
  reading: ProcessorReading | null
  /** When the box last got any answer at all. */
  lastHeard: number | null
  /** Consecutive failed polls, so the pane can say "since 21:40" honestly. */
  misses: number
}

/**
 * Everything that puts a packet on the video network, named.
 *
 * These are the only actions that transmit, they are admin-only, and each
 * needs an intent (below) raised first. Splitting them out as a closed list
 * means "what can this box send" is answerable by reading one type.
 */
export const VIDEO_ACTIONS = ['scan', 'watch'] as const

export type VideoAction = (typeof VIDEO_ACTIONS)[number]

/**
 * The first half of the double confirmation.
 *
 * Asking to transmit and transmitting are two separate requests. The box
 * answers the first with a description of exactly what it would put on the
 * wire and a single-use token; nothing is sent until that token comes back.
 * So an admin has to be shown the consequence before they can accept it, and
 * no single call — mistyped, replayed, or fired by something that got hold of
 * an admin token — can transmit on its own.
 *
 * `willSend` is written for somebody who may have to justify it to a venue's
 * network manager, in the same spirit as the network audit's probe log.
 */
export interface VideoIntent {
  token: string
  action: VideoAction
  /** The processor this is about, for `watch`. */
  processorId?: string
  /** Exactly what will be transmitted, in plain words. */
  willSend: string[]
  /** Where it will go. */
  target: string
  expiresAt: number
}

/** How long an intent is good for. Long enough to read, short enough to mean it. */
export const VIDEO_INTENT_TTL_MS = 2 * 60_000

/**
 * Most processors a box will watch. Well above any real festival — the point
 * is that a paste accident can't turn the box into a scanner.
 */
export const MAX_PROCESSORS = 32

/** Longest a crew-chosen name may be. */
export const MAX_PROCESSOR_NAME = 40

/** Ports crewbox reads from, and the one it refuses to touch. */
export const COEX_HTTP_PORT = 8001
export const SNMP_PORT = 161
export const DISCOVERY_PORT = 3800

/**
 * The register bus. Listed here to be explicit that nothing in crewbox opens
 * it — not even a TCP connect to see whether something answers.
 *
 * A control session on this port is stateful and may be exclusive, so a
 * connection made to satisfy curiosity could take the desk away from the
 * operator using it. "Is anything there" is not worth that, which is why an
 * address that answers nothing reads as `no-read-path` rather than being
 * probed further.
 */
export const REGISTER_BUS_PORT = 5200

/** IPv4 dotted quad, and nothing else — no hostnames, no ranges, no CIDR. */
export function isIpv4(host: string): boolean {
  const parts = host.split('.')
  if (parts.length !== 4) return false
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

/**
 * Health from a reading, and the phrase that explains it.
 *
 * Deliberately conservative about temperature: a controller that doesn't
 * report one is `unknown`, not `ok`. A screens tech reading "fine" off a box
 * that never asked the question is worse off than one reading "couldn't tell".
 */
export function gradeReading(reading: ProcessorReading | null): {
  health: ProcessorHealth
  summary: string
} {
  if (!reading) return { health: 'unknown', summary: 'not contacted' }

  const offline = reading.cabinets.filter((c) => !c.online)
  if (offline.length > 0) {
    return {
      health: 'fault',
      summary:
        offline.length === 1
          ? `cabinet ${offline[0].id} offline`
          : `${offline.length} cabinets offline`,
    }
  }

  const dark = reading.inputs.filter((i) => i.signal === 'no-signal')
  if (dark.length > 0) {
    return {
      health: 'fault',
      summary:
        dark.length === 1 ? `no signal on ${dark[0].name ?? dark[0].id}` : 'inputs with no signal',
    }
  }

  // Blackout and freeze are usually somebody's decision, not a fault — but a
  // wall that is black when nobody meant it to be is exactly the thing you
  // want to notice from the other side of the site, so it is worth a word.
  if (reading.displayMode === 'blackout') return { health: 'warn', summary: 'blacked out' }
  if (reading.displayMode === 'freeze') return { health: 'warn', summary: 'frozen' }

  const temps = reading.cabinets
    .map((c) => c.temperature)
    .filter((t): t is number => t !== undefined)
  const hottest = temps.length > 0 ? Math.max(...temps) : reading.temperature
  if (hottest !== undefined) {
    if (hottest >= HOT_C) return { health: 'warn', summary: `${Math.round(hottest)}°C` }
    return {
      health: 'ok',
      summary: `${reading.cabinets.length} cabinets, ${Math.round(hottest)}°C`,
    }
  }

  if (reading.cabinets.length > 0) {
    return { health: 'ok', summary: `${reading.cabinets.length} cabinets online` }
  }
  return { health: 'unknown', summary: 'answering, but reporting nothing' }
}

/**
 * Where "warm" becomes worth mentioning.
 *
 * Not a manufacturer limit — LED cabinets run hot and the panels are rated
 * well above this. It is the point at which a screens tech would want to walk
 * over and look at it, which is what this pane is for.
 */
export const HOT_C = 60
