import { existsSync, statfsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * What this box can actually do, right now, on this machine.
 *
 * Crewbox used to describe its capabilities in the docs, as tiers: "the
 * one-file box gives up voice, HTTPS and the installable app". That was
 * honest but useless — it told an admin what some hypothetical smaller
 * install lacks, not what the thing running in front of them can do. It also
 * went stale the moment the product changed.
 *
 * This reports the live answer instead, with the fix attached where there is
 * one. Anything that can't be delivered says so plainly rather than being
 * quietly absent.
 */

export type ReadinessState = 'ok' | 'limited' | 'off'

export interface ReadinessCheck {
  id: string
  label: string
  state: ReadinessState
  /** What's true now. */
  detail: string
  /** What to do about it, when there's something to do. */
  fix?: string
}

export interface ReadinessInput {
  /** True when the crew reached this box over TLS. */
  secure: boolean
  voice: 'embedded' | 'external' | 'off'
  /**
   * What the embedded SFU said when asked, just now, to validate one of this
   * box's tokens. Absent when there is nothing to ask (external, off, tests).
   *
   * This is what lets the voice line speak from evidence instead of from
   * config. `rejected` is the case that earns it: something *is* answering
   * on the SFU's port and it is not holding this box's keys, so voice looks
   * configured everywhere and every join fails. A stray livekit-server from
   * an old test session did exactly this for a day.
   */
  sfu?: 'ok' | 'rejected' | 'unreachable'
  /** Why the embedded SFU refused to start, when startup could tell. */
  voiceFailure?: 'port-held' | 'no-start'
  /** CREWBOX_IFACE, when set: the adapter every crew-facing address uses. */
  iface?: string
  /**
   * This machine's LAN IPv4 addresses, best first — the first is what the
   * join QR points at. Passed in so the check is pure and the caller decides
   * when to enumerate.
   */
  addresses?: string[]
  dataDir: string
  crewCount: number
  /** Host the admin used, for copy that names the real address. */
  host: string
}

/** The command that names the squatter. Worth stating once, verbatim. */
const FIND_HOLDER = 'lsof -nP -iTCP:7880 -sTCP:LISTEN'

/** Bytes free on the data volume, or null if it can't be determined. */
export function freeBytes(dataDir: string): number | null {
  try {
    const stats = statfsSync(dataDir)
    return stats.bavail * stats.bsize
  } catch {
    return null
  }
}

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`

/**
 * The voice line, which speaks from evidence where it has any.
 *
 * The cases are ordered by how badly the old copy would have lied about
 * them. "Voice server running inside this box" was, for one real afternoon,
 * printed while the box's SFU was dead and a stranger was answering on its
 * port — the panel's job is to be the thing that would have said so.
 */
/**
 * Which network the crew-facing addresses point at — the check for a box
 * that sits on two.
 *
 * A festival box usually has a crew adapter and a lighting adapter. Every
 * advertised address takes the first entry of `addresses`; without
 * CREWBOX_IFACE that order is whatever the OS enumerated, so the join QR is
 * a coin flip between a network crew phones can reach and one they cannot —
 * and a QR pointing at the lighting VLAN fails in a way that looks like
 * "crewbox is broken", not "wrong network".
 */
function networkCheck(input: ReadinessInput): ReadinessCheck {
  const base = { id: 'network', label: 'Crew network' }
  const addresses = input.addresses ?? []

  if (input.iface && addresses[0] === input.iface) {
    return {
      ...base,
      state: 'ok',
      detail:
        `Crew join links point at ${input.iface}, and the box answers only there ` +
        '(and on localhost). Other networks this machine is on never see its traffic.',
    }
  }
  if (input.iface) {
    // Configured but no adapter has that address: a pulled cable, a DHCP
    // lease change, or a typo. The box has fallen back to answering
    // everywhere rather than nowhere, and this is where that is said.
    return {
      ...base,
      state: 'limited',
      detail:
        `CREWBOX_IFACE is set to ${input.iface}, but no adapter currently has that ` +
        `address — the box is answering on every network` +
        (addresses.length > 0 ? ` and the join QR points at ${addresses[0]}` : '') +
        '.',
      fix: 'Check the cable and the adapter\u2019s IP, then restart the box.',
    }
  }
  if (addresses.length > 1) {
    return {
      ...base,
      state: 'limited',
      detail:
        `This machine is on ${addresses.length} networks (${addresses.join(', ')}) and the ` +
        `join QR points at ${addresses[0]}.`,
      fix:
        'If crew phones are on a different network — say this box also has a leg on the ' +
        'lighting VLAN — set CREWBOX_IFACE to the crew network\u2019s address and restart. ' +
        'That also stops the box answering on the other networks at all.',
    }
  }
  if (addresses.length === 1) {
    return {
      ...base,
      state: 'ok',
      detail: `Crew join links point at ${addresses[0]}, the only network this machine is on.`,
    }
  }
  return {
    ...base,
    state: 'limited',
    detail: 'This machine has no LAN address, so there is nothing for a join QR to point at.',
    fix: 'Connect the box to the crew network.',
  }
}

function voiceCheck(input: ReadinessInput): ReadinessCheck {
  const base = { id: 'voice', label: 'Push-to-talk voice' }

  // The embedded SFU was asked, just now, and something is wrong. These
  // outrank everything below because they are measurements, not config.
  if (input.voice === 'embedded' && input.sfu === 'rejected') {
    return {
      ...base,
      state: 'off',
      detail:
        'Something is answering on the voice port, and it is not this box — it rejects ' +
        'the tokens this box mints, so voice joins fail even though voice looks configured.',
      fix: `Find what is holding the port: ${FIND_HOLDER} — stop it, then restart this box. A voice server left running by something else looks exactly like a working one until someone tries to talk.`,
    }
  }
  if (input.voice === 'embedded' && input.sfu === 'unreachable') {
    return {
      ...base,
      state: 'off',
      detail: 'The voice server inside this box has stopped answering.',
      fix: 'Restart the box. If it keeps happening, start it from a terminal — the log says why.',
    }
  }

  // Startup already knew why there is no SFU. Saying "this build ships
  // without one" here would send someone to download a binary they have.
  if (input.voice === 'off' && input.voiceFailure === 'port-held') {
    return {
      ...base,
      state: 'off',
      detail:
        'Another process was already holding the voice port when this box started, so its own ' +
        'voice server could not run.',
      fix: `Find it: ${FIND_HOLDER} — stop it, then restart this box.`,
    }
  }
  if (input.voice === 'off' && input.voiceFailure === 'no-start') {
    return {
      ...base,
      state: 'off',
      detail: 'The voice server inside this box failed to start.',
      fix: 'Start the box from a terminal — the log says why.',
    }
  }

  if (input.voice === 'off') {
    return {
      ...base,
      state: 'off',
      detail: 'No voice server on this box.',
      fix: 'This build ships without one. Download the release binary rather than running from source, or set LIVEKIT_URL to an SFU you run.',
    }
  }

  return {
    ...base,
    state: input.secure ? 'ok' : 'limited',
    detail:
      input.voice === 'embedded'
        ? // Only claimed once the SFU has validated one of this box's tokens;
          // `sfu` undefined (external, tests) falls through to config wording.
          input.sfu === 'ok'
          ? 'Voice server running inside this box, checked just now — it accepts this box’s tokens.'
          : 'Voice server running inside this box.'
        : 'Using the voice server you configured. Not checked from here.',
    // The mic is gated on a secure context, so without HTTPS voice is
    // real but only reachable from the native apps.
    fix: input.secure
      ? undefined
      : `Works in the Android and iOS apps now. For browsers too, put cert.pem and key.pem for your domain in ${input.dataDir} and restart — the box serves HTTPS itself.`,
  }
}

export function boxReadiness(input: ReadinessInput): ReadinessCheck[] {
  const checks: ReadinessCheck[] = []

  checks.push({
    id: 'chat',
    label: 'Chat, patch sheets and lighting',
    state: 'ok',
    detail: 'Working for everyone, in any phone browser, with or without internet.',
  })

  checks.push(networkCheck(input))

  checks.push(voiceCheck(input))

  checks.push(
    input.secure
      ? {
          id: 'install',
          label: 'Install to home screen, offline shell',
          state: 'ok',
          detail: 'Crew can install crewbox as an app and open it with no signal.',
        }
      : {
          id: 'install',
          label: 'Install to home screen, offline shell',
          state: 'limited',
          detail: `Not available over plain http://${input.host}.`,
          fix: `Browsers only allow this on HTTPS. Put cert.pem and key.pem for your domain in ${input.dataDir} and restart, or use the Android/iOS apps.`,
        }
  )

  const apk = existsSync(join(input.dataDir, 'crewbox.apk'))
  checks.push({
    id: 'apk',
    label: 'Android app download',
    state: apk ? 'ok' : 'off',
    detail: apk
      ? 'Crew can install the Android app straight from this box.'
      : 'No Android app on this box.',
    fix: apk
      ? undefined
      : `Drop crewbox.apk into ${input.dataDir} and it appears on /connect. The Android app is what gives crew lock-screen alerts with no internet.`,
  })

  const free = freeBytes(input.dataDir)
  if (free !== null) {
    // Files and voice recordings are what fill a box up mid-event.
    const low = free < 2e9
    checks.push({
      id: 'disk',
      label: 'Disk space',
      state: low ? 'limited' : 'ok',
      detail: `${gb(free)} free for messages and files.`,
      fix: low
        ? 'Under 2 GB. Clear space before the event — file uploads stop when it runs out.'
        : undefined,
    })
  }

  checks.push({
    id: 'crew',
    label: 'Crew joined',
    state: input.crewCount > 0 ? 'ok' : 'limited',
    detail:
      input.crewCount > 0
        ? `${input.crewCount} ${input.crewCount === 1 ? 'person has' : 'people have'} joined.`
        : 'Nobody has joined yet.',
    fix:
      input.crewCount > 0 ? undefined : `Show the QR at http://${input.host}/connect, or print it.`,
  })

  return checks
}

/** One-line summary for the banner: the worst state present. */
export const worstState = (checks: ReadinessCheck[]): ReadinessState =>
  checks.some((c) => c.state === 'off')
    ? 'off'
    : checks.some((c) => c.state === 'limited')
      ? 'limited'
      : 'ok'
