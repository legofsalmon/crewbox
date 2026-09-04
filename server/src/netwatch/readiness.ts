import type { ReadinessCheck } from '../readiness.ts'
import type { NetWatchStatus } from './listener.ts'
import type { ClockStatus } from './ptp.ts'
import type { MediaService } from './mdns.ts'
import type { SapStream } from './sap.ts'

/**
 * "Audio & media network", beside the lighting panel, same contract: what is
 * true right now, from evidence, with the fix attached where there is one.
 *
 * The line that earns this panel its place is the clock one. A PTP
 * grandmaster election war is the audio-network fault that every device
 * suffers at once and nothing on a desk explains — and it is fully visible
 * to a passive listener, because the election itself is multicast.
 */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const ago = (now: number, then: number): string => {
  const secs = Math.round((now - then) / 1000)
  if (secs < 2) return 'just now'
  if (secs < 90) return `${secs}s ago`
  if (secs < 5400) return `${Math.round(secs / 60)} min ago`
  return `${Math.round(secs / 3600)} h ago`
}

const clock = (at: number): string => new Date(at).toTimeString().slice(0, 5)

/** A short grandmaster identity: the EUI-64 reads as a MAC to most techs. */
const shortId = (id: string): string => id.replace(':ff:fe:', ':').toUpperCase()

export function mediaReadiness(
  status: NetWatchStatus,
  ptp: ClockStatus,
  devices: MediaService[],
  streams: SapStream[],
  now: number,
  /** Announcements the rosters had no room for — see MAX_SERVICES. */
  overflow: { devices: number; streams: number } = { devices: 0, streams: 0 }
): ReadinessCheck[] {
  const checks: ReadinessCheck[] = []

  // A roster at its cap is not a big network, it is a misbehaving one — and
  // the list stops being the answer to "what is on this network", which is
  // what it is for. Said plainly rather than left to be inferred from a
  // number that stopped growing.
  if (overflow.devices > 0 || overflow.streams > 0) {
    checks.push({
      id: 'media-overflow',
      label: 'Media roster',
      state: 'limited',
      detail:
        'More announcements are arriving than this box will list: ' +
        [
          overflow.devices > 0 ? `${overflow.devices} mDNS` : '',
          overflow.streams > 0 ? `${overflow.streams} SAP` : '',
        ]
          .filter(Boolean)
          .join(' and ') +
        ' refused. The lists below are what fitted, not everything on the wire.',
      fix: 'Something on the media network is announcing names it is making up. Look for a device in a reboot loop, or a discovery tool left running.',
    })
  }

  // --- Are the watchers even open ------------------------------------------
  const dark = (['ptp', 'mdns', 'sap'] as const).filter(
    (w) => !status[w].listening && status[w].error
  )
  if (dark.length > 0) {
    checks.push({
      id: 'media-watchers',
      label: 'Watchers',
      state: 'limited',
      detail: dark.map((w) => `${w}: ${status[w].error}`).join('; '),
      fix: 'Another service may hold that port (a local mDNS responder, Dante Virtual Soundcard). The other watchers are unaffected.',
    })
  }

  // --- The clock ------------------------------------------------------------
  if (ptp.grandmasterId !== null) {
    const warring = ptp.changes.length >= 2
    if (warring) {
      checks.push({
        id: 'media-clock',
        label: 'PTP clock',
        state: 'limited',
        detail:
          `The grandmaster has changed ${plural(ptp.changes.length, 'time')} in the last ten minutes ` +
          `(now ${shortId(ptp.grandmasterId)}, since ${clock(ptp.since ?? now)}). Every Dante/AES67 ` +
          'device relocks on each change, and relocking is audible — clicks or dropouts on everything at once.',
        fix: 'Two devices are fighting the election. Look for a preferred-master setting on more than one device, or a device rebooting in a loop — the change times above say when to look.',
      })
    } else {
      checks.push({
        id: 'media-clock',
        label: 'PTP clock',
        state: 'ok',
        detail:
          `Grandmaster ${shortId(ptp.grandmasterId)} (priority ${ptp.priority1 ?? '?'}, ` +
          `class ${ptp.clockClass ?? '?'}), steady since ${clock(ptp.since ?? now)}, ` +
          `heard ${ago(now, ptp.lastAnnounce ?? now)}.`,
      })
    }
    if (ptp.announcers > 1) {
      checks.push({
        id: 'media-clock-announcers',
        label: 'Competing clocks',
        state: 'limited',
        detail: `${plural(ptp.announcers, 'clock is', 'clocks are')} announcing at once. In a settled election only the grandmaster announces; more than one for more than a few seconds usually means two PTP domains or a misconfigured boundary clock.`,
      })
    }
  } else if (ptp.v1Seen) {
    // Classic Dante clocks with PTPv1. Presence and rate are real,
    // measured facts; the grandmaster's identity is deliberately not
    // claimed — see netwatch/ptp.ts for why.
    checks.push({
      id: 'media-clock',
      label: 'PTP clock',
      state: 'ok',
      detail:
        `Dante-style PTPv1 clocking is present (~${ptp.v1RateHz}/s). Crewbox reports v1 presence ` +
        'only — naming the grandmaster awaits verification against captured Dante traffic.',
    })
  } else {
    checks.push({
      id: 'media-clock',
      label: 'PTP clock',
      state: 'limited',
      detail:
        'No PTP traffic seen. A Dante or AES67 network always has a grandmaster announcing, so ' +
        'hearing nothing means this adapter is not on the audio network — or the switch is filtering multicast.',
      fix: 'Check which adapter CREWBOX_WATCH_IFACE names, and that it has a leg on the audio VLAN.',
    })
  }

  // --- Who is out there -----------------------------------------------------
  for (const kind of ['dante', 'ndi'] as const) {
    const of = devices.filter((d) => d.kind === kind)
    if (of.length === 0) continue
    const label = kind === 'dante' ? 'Dante devices' : 'NDI sources'
    const stale = (d: MediaService) => !d.saidGoodbye && now - d.lastSeen > 5 * 60_000
    const gone = of.filter((d) => d.saidGoodbye || stale(d))
    checks.push({
      id: `media-${kind}`,
      label,
      state: gone.length > 0 ? 'limited' : 'ok',
      detail:
        `${plural(of.length, kind === 'dante' ? 'device' : 'source')} seen: ` +
        of
          .slice(0, 6)
          .map(
            (d) =>
              `${d.name}${d.address ? ` (${d.address})` : ''}` +
              (d.saidGoodbye
                ? ' — said goodbye'
                : stale(d)
                  ? ` — last heard ${ago(now, d.lastSeen)}`
                  : '')
          )
          .join(', ') +
        (of.length > 6 ? `, and ${of.length - 6} more` : '') +
        '. Heard from their own announcements; crewbox never queries.',
      fix:
        gone.length > 0
          ? `${plural(gone.length, 'device has', 'devices have')} dropped off the network — check their power and cable before their settings.`
          : undefined,
    })
  }

  // --- The stream directory -------------------------------------------------
  if (streams.length > 0) {
    checks.push({
      id: 'media-streams',
      label: 'AES67 streams',
      state: 'ok',
      detail:
        `${plural(streams.length, 'stream')} announced: ` +
        streams
          .slice(0, 6)
          .map((s) => `${s.name}${s.connection ? ` → ${s.connection}` : ''}`)
          .join(', ') +
        (streams.length > 6 ? `, and ${streams.length - 6} more` : '') +
        '. Dante flows appear here only when explicitly put in AES67 mode.',
    })
  }

  return checks
}
