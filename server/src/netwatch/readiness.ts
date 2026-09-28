import type { ReadinessCheck } from '../readiness.ts'
import type { NetWatchStatus } from './listener.ts'
import type { ClockStatus } from './ptp.ts'
import type { MediaService } from './mdns.ts'
import type { SapStream } from './sap.ts'
import { bitrate } from './sdp.ts'
import {
  describeDomain,
  faultFix,
  findingWords,
  isFault,
  isWorthALook,
  type VideoClockDomain,
} from './st2059.ts'

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

/**
 * One announced ST 2110 stream in a few words: "CAM 1 (video at 2.07 Gb/s →
 * 239.1.1.1)". The linter's own summary says far more, and six of them in a
 * row is a paragraph nobody reads on a phone; the bitrate is the fact that
 * decides whether a link can take the stream at all.
 */
function streamWords(stream: SapStream): string {
  const facts = stream.sdp?.streams ?? []
  const essences = [...new Set(facts.map((f) => f.essence))].join(' and ')
  const rate = facts.find((f) => f.bitrate !== null)?.bitrate
  const destinations = [...new Set(facts.flatMap((f) => (f.destination ? [f.destination] : [])))]
  const words = [
    essences || 'stream',
    rate ? ` at ${bitrate(rate)}` : '',
    destinations.length > 0 ? ` → ${destinations.join(' and ')}` : '',
  ].join('')
  return `${stream.name} (${words})`
}

export function mediaReadiness(
  status: NetWatchStatus,
  ptp: ClockStatus,
  devices: MediaService[],
  streams: SapStream[],
  now: number,
  /** Announcements the rosters had no room for — see MAX_SERVICES. */
  overflow: { devices: number; streams: number } = { devices: 0, streams: 0 },
  /** Domains running SMPTE ST 2059-2 — see netwatch/st2059.ts. */
  video: VideoClockDomain[] = []
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
      fix: 'Check which adapter Box settings → Media network adapter names, and that it has a leg on the audio VLAN.',
    })
  }

  // --- The video clock ------------------------------------------------------
  // Only for domains running the SMPTE profile, so an audio rig never sees
  // it; the line above has already said who the grandmaster is and whether
  // it is steady. This one says whether video can lock to it.
  if (video.length > 0) {
    const faults = video.flatMap((d) => d.findings.filter(isFault))
    const looks = video.flatMap((d) => d.findings.filter(isWorthALook))
    const words = (f: (typeof faults)[number]) => findingWords(f, shortId)
    checks.push({
      id: 'media-video-clock',
      label: 'Video clock (ST 2059-2)',
      state: faults.length > 0 ? 'limited' : 'ok',
      detail:
        (faults.length > 0
          ? `Breaks ST 2059-2: ${faults.slice(0, 3).map(words).join('; ')}` +
            (faults.length > 3 ? `; and ${faults.length - 3} more` : '') +
            '. '
          : '') +
        video.map((d) => describeDomain(d, shortId)).join('. ') +
        '.' +
        (looks.length > 0
          ? ` Worth a look: ${words(looks[0]!)}` +
            (looks.length > 1 ? `, and ${plural(looks.length - 1, 'other')}.` : '.')
          : ''),
      fix: faults.length > 0 ? faultFix(faults[0]!) : undefined,
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
        '. Heard from their own announcements; crewbox asks only when an admin runs the deep probe.',
      fix:
        gone.length > 0
          ? `${plural(gone.length, 'device has', 'devices have')} dropped off the network — check their power and cable before their settings.`
          : undefined,
    })
  }

  // --- The stream directory -------------------------------------------------
  // ST 2110 streams get a line of their own: their SDP files are checked,
  // and calling a camera an AES67 stream would be wrong twice over. Anything
  // not (yet) known to be ST 2110 stays here, as it always has.
  const aes67 = streams.filter((s) => !s.sdp?.st2110)
  if (aes67.length > 0) {
    checks.push({
      id: 'media-streams',
      label: 'AES67 streams',
      state: 'ok',
      detail:
        `${plural(aes67.length, 'stream')} announced: ` +
        aes67
          .slice(0, 6)
          .map((s) => `${s.name}${s.connection ? ` → ${s.connection}` : ''}`)
          .join(', ') +
        (aes67.length > 6 ? `, and ${aes67.length - 6} more` : '') +
        '. Dante flows appear here only when explicitly put in AES67 mode.',
    })
  }

  const st2110 = streams.filter((s) => s.sdp?.st2110)
  if (st2110.length > 0) {
    const problem = (s: SapStream, severity: 'error' | 'warning') =>
      s.sdp?.problems.find((p) => p.severity === severity)
    const faulty = st2110.filter((s) => problem(s, 'error'))
    const doubtful = st2110.filter((s) => !problem(s, 'error') && problem(s, 'warning'))
    const said = (s: SapStream, severity: 'error' | 'warning') => {
      const p = problem(s, severity)!
      return `${s.name}: ${p.message}${p.line ? ` (line ${p.line})` : ''}`
    }
    checks.push({
      id: 'media-st2110-streams',
      label: 'ST 2110 streams',
      state: faulty.length > 0 ? 'limited' : 'ok',
      detail:
        (faulty.length > 0
          ? `${plural(faulty.length, 'announced SDP file')} ${faulty.length === 1 ? 'is' : 'are'} ` +
            `wrong in a way a receiver can refuse: ${faulty
              .slice(0, 3)
              .map((s) => said(s, 'error'))
              .join('; ')}` +
            (faulty.length > 3 ? `; and ${faulty.length - 3} more` : '') +
            '. '
          : '') +
        `${plural(st2110.length, 'stream')} announced: ` +
        st2110.slice(0, 6).map(streamWords).join(', ') +
        (st2110.length > 6 ? `, and ${st2110.length - 6} more` : '') +
        '.' +
        (doubtful.length > 0
          ? ` Worth a look: ${said(doubtful[0]!, 'warning')}` +
            (doubtful.length > 1 ? `, and ${plural(doubtful.length - 1, 'other file')}.` : '.')
          : '') +
        ' Read from their announcements; crewbox never joins a stream.',
      fix:
        faulty.length > 0
          ? 'Correct the file at the sender, in its own settings or through NMOS. Network → Check an SDP file goes through a copy line by line.'
          : undefined,
    })
  }

  // --- The checks themselves ------------------------------------------------
  if (status.checks) {
    checks.push({
      id: 'media-st2110-checks',
      label: 'ST 2110 checks',
      state: 'limited',
      detail: `The ST 2110 checks could not load (${status.checks}), so announced SDP files are listed but not checked, and the video clock is not checked against ST 2059-2.`,
      fix: 'Restart the box. The checks are part of it, so if this persists the download is damaged: download it again.',
    })
  }

  return checks
}
