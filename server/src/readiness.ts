import { statfsSync } from 'node:fs'
import { latestApk } from './box.ts'
import type { PowerReading } from './power.ts'

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
   * The address this process is actually listening on, decided once at boot.
   *
   * `'0.0.0.0'` (or absent) means every adapter. The distinction matters
   * because the configuration and the bind can disagree in both directions:
   * a crew adapter that was down at boot leaves the box answering
   * everywhere even after the cable goes back in, and a box bound to an
   * address that has since gone is answering nowhere. Both used to be read
   * off the live adapters and reported as the opposite of what was true.
   */
  boundHost?: string
  /**
   * This machine's LAN IPv4 addresses, best first — the first is what the
   * join QR points at. Passed in so the check is pure and the caller decides
   * when to enumerate.
   */
  addresses?: string[]
  /** Saved network settings differ from what this process booted with. */
  restartNeeded?: boolean
  /**
   * The OS-probe responder: whether it got its port, and why not. Absent when
   * the box was never asked to run one (running from source, tests), in which
   * case the row is left off entirely rather than reported as broken.
   */
  captive?: { listening: boolean; port?: number; fallback?: boolean; reason?: string }
  /**
   * Mains or battery, when this machine has a battery to speak of. Absent on
   * a desktop, and on Windows where asking costs more than the answer is
   * worth — the row is simply left off rather than guessed at.
   */
  power?: PowerReading
  /**
   * What the crew's own devices said comms sounded like, over the last few
   * minutes. Absent when nobody has been on voice, or when the audit that
   * collects it is off.
   *
   * Concealment is the share of audio a decoder had to fabricate to cover a
   * gap, which is the number that corresponds to what a person actually
   * heard — loss and jitter can both look poor while a jitter buffer absorbs
   * them and nobody notices a thing.
   */
  voiceQuality?: { concealedPct: number; lossPct: number; devices: number } | null
  /** When backup.sh last finished here, if it ever has. */
  backup?: { at: number; dest?: string } | null
  /** Clock for the backup age. Injected so the check stays pure. */
  now?: number
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

  // Outranks everything below: whatever else is true of the running config,
  // the saved one is different, and every other line here describes a state
  // that changes at the next start.
  if (input.restartNeeded) {
    return {
      ...base,
      state: 'limited',
      detail:
        'Network settings have been saved, but this box is still running with its old ones. ' +
        'Join links already point at the saved crew network; the binding and the lighting ' +
        'listener change at the next start.',
      fix: 'Restart the box — close it and run it again. Nothing else is lost: crew rejoin automatically.',
    }
  }

  // What the box is actually listening on. Absent (tests, nothing bound
  // yet) means fall back to describing the configuration, as before.
  const everywhere = !input.boundHost || input.boundHost === '0.0.0.0' || input.boundHost === '::'
  const boundToIface = Boolean(input.iface) && input.boundHost === input.iface

  if (input.iface && !everywhere && !boundToIface && input.boundHost) {
    // Bound to something that is not the configured adapter — the saved
    // setting changed without a restart, or the address moved.
    return {
      ...base,
      state: 'limited',
      detail:
        `The box is answering on ${input.boundHost}, but crew join links point at ` +
        `${input.iface}. It has been bound to that address since it started.`,
      fix: 'Restart the box to bind the crew adapter. Crew rejoin automatically.',
    }
  }

  if (input.iface && boundToIface) {
    const present = addresses[0] === input.iface
    return {
      ...base,
      state: present ? 'ok' : 'limited',
      detail: present
        ? `Crew join links point at ${input.iface}, and the box answers only there ` +
          '(and on localhost). Other networks this machine is on never see its traffic.'
        : `The box is bound to ${input.iface}, and no adapter has that address any more — ` +
          'so it is answering nowhere. A pulled cable, or a DHCP lease that moved.',
      ...(present
        ? {}
        : { fix: 'Put the cable back, or restart the box once the adapter has its address.' }),
    }
  }

  if (input.iface && input.boundHost && everywhere) {
    // Configured, but the adapter was not up when the box bound, so it fell
    // back to every network. Saying "answers only there" once the cable is
    // back in — which is what reading the live adapters did — is the answer
    // an operator would act on and the wrong one.
    const back = addresses[0] === input.iface
    return {
      ...base,
      state: 'limited',
      detail:
        `${input.iface} was not up when the box started, so it is answering on every ` +
        `network this machine is on` +
        (back
          ? ' — including the crew adapter, which is back now.'
          : `${addresses.length > 0 ? ` and the join QR points at ${addresses[0]}` : ''}.`),
      fix: back
        ? 'Restart the box to answer only on the crew adapter. Crew rejoin automatically.'
        : 'Check the cable and the adapter\u2019s IP, then restart the box.',
    }
  }

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

/**
 * Whether phones will stay on the crew Wi-Fi.
 *
 * Every phone OS probes one plain-HTTP URL on joining to decide whether a
 * network has internet, and iOS answers "no" by dropping to cellular — which
 * puts the box, on a private address, out of reach while the phone still
 * shows as connected. The box can answer those probes (captive.ts), but only
 * if it holds port 80 and only if the router's DNS sends them here.
 *
 * It can prove the first half and not the second, so the line says exactly
 * that rather than claiming a fix it cannot see.
 */
function captiveCheck(captive: NonNullable<ReadinessInput['captive']>): ReadinessCheck {
  const base = { id: 'captive', label: 'Phones stay on this Wi-Fi' }
  if (!captive.listening) {
    return {
      ...base,
      state: 'limited',
      detail:
        'This box is not answering the checks phones make to decide whether a network has ' +
        'internet. Without them an iPhone drops to mobile data and loses the box, showing ' +
        '“Connecting” with the Wi-Fi still joined.',
      fix: captive.reason,
    }
  }
  // Listening, but not where the phones are looking. This is the ordinary
  // state of a double-clicked Mac app — port 80 needs root — and it is a
  // separate case from "not listening" because the fix is one rule rather
  // than a rethink, and from "working" because right now nothing reaches it.
  if (captive.fallback) {
    return {
      ...base,
      state: 'limited',
      detail:
        `Port 80 needs root, which this box does not have, so it is answering on port ` +
        `${captive.port ?? 80} instead. Phones only ask on port 80, so nothing reaches it yet.`,
      fix:
        'Send port 80 here with one rule — Download port 80 config below has it, with this ' +
        'adapter and address already filled in. Running the box as root would also work and ' +
        'is worse: it elevates the whole server to hold one socket.',
    }
  }

  return {
    ...base,
    state: 'ok',
    detail:
      `Answering connectivity checks on port ${captive.port ?? 80}, so phones treat this ` +
      'network as usable instead of falling back to mobile data.',
    fix:
      'Only reaches the box if the event router points the probe hostnames here. Download ' +
      'the DNS config below and paste its optional second block onto the router.',
  }
}

/** "2h 10m", "45 min" — for a line someone reads at a glance, in the dark. */
function duration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

/**
 * Mains or battery.
 *
 * The point of this row is that it appears *before* it matters. A laptop box
 * running on battery is not a fault — it is a normal five minutes while
 * someone moves a desk — but nobody notices the difference between that and
 * four hours until the machine sleeps mid-set and takes every channel with
 * it. So it escalates with what is actually left, and never shouts on mains.
 */
function powerCheck(power: PowerReading): ReadinessCheck {
  const base = { id: 'power', label: 'Power' }
  const charge = power.percent === undefined ? '' : ` Battery at ${power.percent}%`

  if (power.onMains) {
    return {
      ...base,
      state: 'ok',
      detail: charge
        ? `Running on mains.${charge}, which is the buffer if the power drops.`
        : 'Running on mains.',
    }
  }

  const left = power.minutesLeft
  const remaining = left === undefined ? '' : `, about ${duration(left)} left`
  const urgent = (left !== undefined && left <= 30) || (power.percent ?? 100) <= 15
  return {
    ...base,
    state: urgent ? 'off' : 'limited',
    detail:
      `Running on battery${power.percent === undefined ? '' : ` — ${power.percent}%`}` +
      `${remaining}. Every crew channel on this box goes with it.`,
    fix: urgent
      ? 'Plug it in now, or move crew to the spare before this machine sleeps.'
      : 'Plug it in. A box on battery is fine while someone is moving a desk, and not fine for a show.',
  }
}

/**
 * Whether anyone has actually taken a backup.
 *
 * The scripts and the drill have existed for a while; what was missing was
 * any way to notice that nobody has run them. A backup regime that quietly
 * stopped three events ago looks exactly like a working one from here, right
 * up until the box dies.
 */
function backupCheck(mark: { at: number; dest?: string }, now: number): ReadinessCheck {
  const base = { id: 'backup', label: 'Backup' }
  const ageMinutes = Math.max(0, Math.round((now - mark.at) / 60_000))
  const where = mark.dest ? ` to ${mark.dest}` : ''
  // A day is the right line: backup.sh is meant to run nightly, and an event
  // that has been up longer than that with no backup has real work in it.
  const stale = ageMinutes > 24 * 60
  return {
    ...base,
    state: stale ? 'limited' : 'ok',
    detail: `Last backup ${duration(ageMinutes)} ago${where}.`,
    fix: stale
      ? 'Run deploy/backup.sh. Chat history, accounts, uploads and the event PIN live only in this box until it has run.'
      : undefined,
  }
}

/**
 * The voice line, which speaks from evidence where it has any.
 *
 * The cases are ordered by how badly the old copy would have lied about
 * them. "Voice server running inside this box" was, for one real afternoon,
 * printed while the box's SFU was dead and a stranger was answering on its
 * port — the panel's job is to be the thing that would have said so.
 */
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

/**
 * How comms actually sounded, from the only place that can know.
 *
 * The box measures its own network and it always looks well from where it is
 * standing. This line exists because the interesting failure is the one the
 * box cannot see: a phone behind a truck, an access point at the edge of its
 * range, a crew member whose comms are breaking up while every server-side
 * number stays green.
 *
 * Silent when nobody has been on voice. A row that says "fine" about a thing
 * it has no evidence for is how the panel loses the right to be believed.
 */
function voiceQualityCheck(quality: NonNullable<ReadinessInput['voiceQuality']>): ReadinessCheck {
  const base = { id: 'voice-quality', label: 'How comms sound' }
  const heard =
    `${quality.concealedPct.toFixed(1)}% of comms audio was patched over by the ` +
    `decoder on the worst-affected device${quality.devices === 1 ? '' : ` of ${quality.devices}`}`

  // The thresholds are about audibility, not about networking. Below about a
  // per cent nobody reports anything; by five it is the thing they mention.
  if (quality.concealedPct >= 5) {
    return {
      ...base,
      state: 'off',
      detail: `Comms are breaking up — ${heard}.`,
      fix: 'Someone is at the edge of the Wi-Fi, or an access point is overloaded. The Network pane names which link, and the running order says who is where.',
    }
  }
  if (quality.concealedPct >= 1) {
    return {
      ...base,
      state: 'limited',
      detail: `Comms are audibly rough in places — ${heard}.`,
      fix: 'Worth a look before it matters: the Network pane shows which link is struggling.',
    }
  }
  return {
    ...base,
    state: 'ok',
    detail:
      quality.lossPct >= 2
        ? // Worth saying out loud: it is the case where the network numbers
          // look alarming and the crew heard nothing wrong, and somebody
          // chasing the loss figure would be chasing nothing.
          `Clean — ${quality.lossPct.toFixed(1)}% of packets were late or lost, and the buffer covered it.`
        : 'Clean, on every device that has been on voice.',
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

  if (input.captive) checks.push(captiveCheck(input.captive))

  // Next to the network row: both describe this machine's physical situation
  // rather than its configuration, and both fail the same way — suddenly.
  if (input.power) checks.push(powerCheck(input.power))

  checks.push(voiceCheck(input))
  // Only with evidence. See voiceQualityCheck.
  if (input.voiceQuality) checks.push(voiceQualityCheck(input.voiceQuality))

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

  const apk = latestApk(input.dataDir) !== null
  checks.push({
    id: 'apk',
    label: 'Android app download',
    state: apk ? 'ok' : 'off',
    detail: apk
      ? 'Crew can install the Android app straight from this box.'
      : 'No Android app on this box.',
    fix: apk
      ? undefined
      : `Drop the .apk from the release into ${input.dataDir} — any crewbox*.apk name works — and it appears on /connect. The Android app is what gives crew lock-screen alerts with no internet.`,
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

  // `undefined` means nobody looked (tests, an older caller); `null` means
  // the box looked and there has never been one, which is worth saying out
  // loud rather than leaving as a silent gap in the list.
  if (input.backup !== undefined) {
    checks.push(
      input.backup
        ? backupCheck(input.backup, input.now ?? Date.now())
        : {
            id: 'backup',
            label: 'Backup',
            state: 'limited',
            detail: 'No backup has ever been taken from this box.',
            fix: 'Run deploy/backup.sh — onto a USB stick, before the event rather than during it. Chat history, accounts, uploads and the event PIN exist nowhere else.',
          }
    )
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
      input.crewCount > 0
        ? undefined
        : // http:// was hardcoded, so on a box with a certificate this line
          // sent whoever read it to a port that only speaks TLS.
          `Show the QR at ${input.secure ? 'https' : 'http'}://${input.host}/connect, or print it.`,
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
