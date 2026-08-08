import type { ArtNode, DiscoveredSource, DmxOutage, UniverseHealth } from '../dmx/state.ts'
import type { NetWatchStatus } from '../netwatch/listener.ts'
import type { ClockStatus } from '../netwatch/ptp.ts'
import type { MediaService } from '../netwatch/mdns.ts'
import type { SapStream } from '../netwatch/sap.ts'
import type { AuditEvent, ProbeRunRecord, RollupRow } from './metrics.ts'

/**
 * The judge: live state + recent history + the last deep probe in,
 * a graded report out. Pure — no clocks read, no I/O — so every grade is a
 * unit test.
 *
 * The copy follows the readiness panels' rule: say what is true right now,
 * with numbers and clock times, and attach the fix to anything that isn't
 * ok. A finding may point at a metric series so the pane can draw the
 * sparkline beside the sentence — the graph is the evidence, the sentence
 * is the verdict.
 */

export type FindingState = 'ok' | 'info' | 'limited' | 'off'

export interface AuditFinding {
  id: string
  label: string
  state: FindingState
  detail: string
  fix?: string
  /** Series backing this finding, for the sparkline beside the row. */
  series?: { metric: string; key: string }
}

export type NetworkGrade = 'ok' | 'limited' | 'off' | 'unknown'

export interface AuditNetwork {
  id: 'crew' | 'lighting' | 'media'
  label: string
  grade: NetworkGrade
  findings: AuditFinding[]
}

export interface AuditReport {
  generatedAt: number
  networks: AuditNetwork[]
}

export interface ScoreInput {
  now: number
  configured: { dmx: boolean; watch: boolean }
  hub: { connections: number; onlineUsers: number }
  dmx?: {
    health: UniverseHealth[]
    outages: DmxOutage[]
    discovered: DiscoveredSource[]
    nodes: ArtNode[]
  }
  ptp?: ClockStatus
  watch?: NetWatchStatus
  mdns?: MediaService[]
  sap?: SapStream[]
  /** Rollups for one series over the scorer's window (typically 15 min). */
  recentSeries: (metric: string, key: string) => RollupRow[]
  /** Events from the last hour, any order. */
  events: AuditEvent[]
  probe: ProbeRunRecord | null
}

/** Sustained loss that deserves a warning / a fault (15-min average). */
export const LOSS_LIMITED_PCT = 1
export const LOSS_OFF_PCT = 5

/** A healthy rig refreshes 20–44 Hz; below this it is sagging. */
export const RATE_SAG_HZ = 15

/** Grandmaster changes inside PTP's 10-min window: 1–2 worrying, 3+ a war. */
export const GM_CHANGES_LIMITED = 1
export const GM_CHANGES_OFF = 3

/** The multicast group-timeout cycle a missing IGMP querier produces. */
const CYCLE_MIN_MS = 3 * 60_000
const CYCLE_MAX_MS = 7 * 60_000
const CYCLE_MIN_EVENTS = 3

const clock = (at: number): string => new Date(at).toTimeString().slice(0, 5)

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** Grade = worst finding, with `info` counting as ok (it is information). */
export function worstFinding(findings: AuditFinding[]): NetworkGrade {
  let grade: NetworkGrade = 'ok'
  for (const f of findings) {
    if (f.state === 'off') return 'off'
    if (f.state === 'limited') grade = 'limited'
  }
  return grade
}

/** Average of a series' bucket averages, weighted by sample count. */
function windowAvg(rows: RollupRow[]): number | null {
  let sum = 0
  let count = 0
  for (const row of rows) {
    sum += row.avg * row.count
    count += row.count
  }
  return count > 0 ? sum / count : null
}

function windowMax(rows: RollupRow[]): number | null {
  return rows.length > 0 ? Math.max(...rows.map((r) => r.max)) : null
}

/**
 * The missing-IGMP-querier signature, inferred from symptoms rather than
 * probed: with snooping on and no querier, switches age every multicast
 * group out on a fixed cycle, so the traffic dies and returns every few
 * minutes. Crewbox never transmits IGMP (it can't without root, and winning
 * the querier election only to vanish would cause exactly this fault), so
 * the honest evidence is the rhythm of the outages themselves.
 */
export function cyclicOutages(events: AuditEvent[], kinds: string[]): number[] {
  const times = events
    .filter((e) => kinds.includes(e.kind))
    .map((e) => e.at)
    .sort((a, b) => a - b)
  if (times.length < CYCLE_MIN_EVENTS) return []
  const gaps: number[] = []
  for (let i = 1; i < times.length; i++) gaps.push(times[i]! - times[i - 1]!)
  const cyclic = gaps.filter((g) => g >= CYCLE_MIN_MS && g <= CYCLE_MAX_MS)
  // Most of the gaps in the cycle band, and enough of them to be a rhythm.
  return cyclic.length >= 2 && cyclic.length >= gaps.length - 1 ? times : []
}

export function scoreAudit(input: ScoreInput): AuditReport {
  return {
    generatedAt: input.now,
    networks: [scoreCrew(input), scoreLighting(input), scoreMedia(input)],
  }
}

// -- crew ---------------------------------------------------------------------

function scoreCrew(input: ScoreInput): AuditNetwork {
  const findings: AuditFinding[] = []

  findings.push({
    id: 'crew-clients',
    label: 'Crew devices',
    state: 'info',
    detail:
      `${plural(input.hub.connections, 'connection')} open, ` +
      `${plural(input.hub.onlineUsers, 'crew member')} online.`,
    series: { metric: 'crew.connections', key: '' },
  })

  const rtt = input.recentSeries('crew.rtt', '')
  const rttAvg = windowAvg(rtt)
  if (rttAvg !== null) {
    const state: FindingState = rttAvg <= 150 ? 'ok' : rttAvg <= 400 ? 'limited' : 'off'
    findings.push({
      id: 'crew-rtt',
      label: 'Wi-Fi round trip',
      state,
      detail: `Crew phones average ${Math.round(rttAvg)} ms to the box over the last 15 min.`,
      ...(state === 'ok'
        ? {}
        : {
            fix: 'Slow Wi-Fi, not a slow box: add an access point near the stage, and get crew phones off the venue guest SSID.',
          }),
      series: { metric: 'crew.rtt', key: '' },
    })
  }

  // Uplink and DNS verdicts come from the last deep probe, when one has run.
  const probes = probeResults(input.probe)
  for (const id of ['crew-uplink', 'crew-dns']) {
    const result = probes.find((p) => p.id === id)
    if (result) {
      findings.push({
        id,
        label: id === 'crew-uplink' ? 'Internet uplink' : 'Venue DNS',
        state: result.state === 'skipped' ? 'info' : result.state,
        detail: result.detail,
        ...(result.fix ? { fix: result.fix } : {}),
      })
    }
  }

  return { id: 'crew', label: 'Crew network', grade: worstFinding(findings), findings }
}

// -- lighting -----------------------------------------------------------------

function scoreLighting(input: ScoreInput): AuditNetwork {
  const findings: AuditFinding[] = []

  if (!input.configured.dmx || !input.dmx) {
    findings.push({
      id: 'light-listening',
      label: 'Lighting network',
      state: 'off',
      detail: 'Not listening to Art-Net or sACN.',
      fix: 'Turn on lighting-network listening in Setup or the admin panel, with the box on the lighting network.',
    })
    return { id: 'lighting', label: 'Lighting network', grade: 'unknown', findings }
  }

  const live = input.dmx.health.filter((u) => u.sources.length > 0)
  if (live.length === 0) {
    findings.push({
      id: 'light-arriving',
      label: 'Lighting data',
      state: 'limited',
      detail: 'Listening, but nothing is arriving.',
      fix: 'Check the box is on the lighting network (right port, right VLAN) and that IGMP snooping has a querier.',
    })
  } else {
    findings.push({
      id: 'light-arriving',
      label: 'Lighting data',
      state: 'ok',
      detail: `${plural(live.length, 'universe')} live.`,
    })
  }

  // Loss and rate are judged over the 15-minute window, not one glance.
  for (const universe of live) {
    const key = String(universe.universe)
    const loss = windowAvg(input.recentSeries('dmx.lossPct', key))
    if (loss !== null && loss >= LOSS_LIMITED_PCT) {
      findings.push({
        id: `light-loss-${key}`,
        label: `Universe ${key} frame loss`,
        state: loss >= LOSS_OFF_PCT ? 'off' : 'limited',
        detail: `Universe ${key} lost ${loss.toFixed(1)}% of frames over the last 15 min.`,
        fix: 'Check the switch port (duplex/errors) and keep sACN off Wi-Fi links.',
        series: { metric: 'dmx.lossPct', key },
      })
    }
    const rateRows = input.recentSeries('dmx.rateHz', key)
    const rateAvg = windowAvg(rateRows)
    const rateMax = windowMax(rateRows)
    if (rateAvg !== null && rateMax !== null && rateAvg < RATE_SAG_HZ && rateMax >= 30) {
      findings.push({
        id: `light-rate-${key}`,
        label: `Universe ${key} refresh rate`,
        state: 'limited',
        detail: `Universe ${key} averaged ${rateAvg.toFixed(0)} Hz over 15 min but has reached ${rateMax.toFixed(0)} Hz — the stream is sagging.`,
        fix: 'A congested or half-duplex link between console and box drops refresh first. Check the path.',
        series: { metric: 'dmx.rateHz', key },
      })
    }
  }

  const conflicted = live.filter((u) => u.conflict)
  if (conflicted.length > 0) {
    findings.push({
      id: 'light-conflict',
      label: 'Two sources on one universe',
      state: 'limited',
      detail: conflicted.map((u) => `Universe ${u.universe}`).join(', ') + ' contested right now.',
      fix: 'Give the consoles distinct priorities, or unpatch one.',
    })
  }
  const conflictEvents = input.events.filter((e) => e.kind === 'dmx.conflict.start')
  if (conflicted.length === 0 && conflictEvents.length > 0) {
    const last = conflictEvents.reduce((a, b) => (a.at > b.at ? a : b))
    findings.push({
      id: 'light-conflict',
      label: 'Two sources on one universe',
      state: 'info',
      detail: `${plural(conflictEvents.length, 'conflict')} in the last hour, most recently at ${clock(last.at)}. Resolved now.`,
    })
  }

  const frozen = live.filter((u) => u.sync === 'frozen')
  if (frozen.length > 0) {
    findings.push({
      id: 'light-sync',
      label: 'Stage frozen',
      state: 'off',
      detail:
        frozen.map((u) => `Universe ${u.universe}`).join(', ') +
        ' held on the last synchronised look — the desk keeps sending, the stage has stopped following.',
      fix: 'The synchronisation stream died. Restart it at the console, or turn sync off there.',
    })
  }

  const cycle = cyclicOutages(
    input.events.filter((e) => e.network === 'lighting'),
    ['dmx.outage']
  )
  if (cycle.length > 0) {
    findings.push({
      id: 'light-cycle',
      label: 'Multicast dies on a cycle',
      state: 'limited',
      detail:
        `${plural(cycle.length, 'outage')} at a regular few-minute rhythm (last at ${clock(cycle[cycle.length - 1]!)}) — ` +
        'the classic signature of IGMP snooping with no querier: switches age the multicast groups out on a timer.',
      fix: "Enable the IGMP querier on the core switch (or disable snooping on the lighting VLAN). Crewbox can't probe this directly — it never transmits IGMP.",
    })
  }

  const nodesProbe = probeResults(input.probe).find((p) => p.id === 'artnet-inventory')
  if (nodesProbe) {
    findings.push({
      id: 'light-nodes',
      label: 'Art-Net inventory',
      state: nodesProbe.state === 'skipped' ? 'info' : nodesProbe.state,
      detail: nodesProbe.detail,
      ...(nodesProbe.fix ? { fix: nodesProbe.fix } : {}),
    })
  }

  return { id: 'lighting', label: 'Lighting network', grade: worstFinding(findings), findings }
}

// -- media --------------------------------------------------------------------

function scoreMedia(input: ScoreInput): AuditNetwork {
  const findings: AuditFinding[] = []

  if (!input.configured.watch || !input.watch) {
    findings.push({
      id: 'media-watching',
      label: 'Audio & media network',
      state: 'off',
      detail: 'Not watching the media network (PTP clock, Dante/NDI rosters).',
      fix: 'Set CREWBOX_WATCH=1 and restart, with the box on the media network.',
    })
    return { id: 'media', label: 'Audio & media network', grade: 'unknown', findings }
  }

  const ptp = input.ptp
  if (ptp) {
    if (ptp.grandmasterId) {
      const changes = ptp.changes.length
      const state: FindingState =
        changes >= GM_CHANGES_OFF ? 'off' : changes >= GM_CHANGES_LIMITED ? 'limited' : 'ok'
      findings.push({
        id: 'media-clock',
        label: 'PTP clock',
        state,
        detail:
          state === 'ok'
            ? `Clock steady${ptp.since ? ` since ${clock(ptp.since)}` : ''} (${ptp.grandmasterId}).`
            : `${plural(changes, 'grandmaster change')} in the last 10 minutes — ` +
              (changes >= GM_CHANGES_OFF ? 'an election war. ' : 'the clock is moving. ') +
              'Every device clicks or drops when the clock moves.',
        ...(state === 'ok'
          ? {}
          : {
              fix: 'Pin one device as preferred master (lowest priority1), and look for a device power-cycling or a flapping link.',
            }),
      })
      if (ptp.announcers > 1) {
        findings.push({
          id: 'media-announcers',
          label: 'Clocks announcing',
          state: 'limited',
          detail: `${plural(ptp.announcers, 'clock is', 'clocks are')} announcing at once — an election is running.`,
          series: { metric: 'media.ptpAnnouncers', key: '' },
        })
      }
      if (ptp.v1Seen) {
        findings.push({
          id: 'media-mixed-ptp',
          label: 'Mixed PTP generations',
          state: 'info',
          detail: `PTPv1 (classic Dante, ${ptp.v1RateHz} pkt/s) and PTPv2 share this wire.`,
          fix: 'Fine on one flat network; across switches it needs v1-aware hardware or a boundary clock.',
        })
      }
    } else if (ptp.v1Seen) {
      findings.push({
        id: 'media-clock',
        label: 'PTP clock',
        state: 'ok',
        detail: `Classic Dante clocking (PTPv1) present at ${ptp.v1RateHz} pkt/s.`,
        series: { metric: 'media.ptpV1RateHz', key: '' },
      })
    } else {
      findings.push({
        id: 'media-clock',
        label: 'PTP clock',
        state: 'limited',
        detail:
          'No PTP clock heard. If audio-over-IP is on this network, that is the first fault to chase.',
        fix: 'Check the box is on the media VLAN and multicast reaches it (querier again).',
      })
    }
  }

  const gone = input.events.filter((e) => e.kind === 'media.device.gone')
  if (gone.length > 0) {
    const last = gone.reduce((a, b) => (a.at > b.at ? a : b))
    findings.push({
      id: 'media-churn',
      label: 'Devices dropping',
      state: 'limited',
      detail: `${plural(gone.length, 'device')} left the network in the last hour, most recently at ${clock(last.at)}.`,
      fix: 'A device that says goodbye is rebooting or losing its link — check its PoE budget and cable.',
      series: { metric: 'media.mdnsDevices', key: '' },
    })
  }

  const devices = input.mdns ?? []
  const streams = input.sap ?? []
  findings.push({
    id: 'media-roster',
    label: 'Media roster',
    state: 'info',
    detail:
      `${plural(devices.filter((d) => d.kind === 'dante').length, 'Dante device')}, ` +
      `${plural(devices.filter((d) => d.kind === 'ndi').length, 'NDI source')}, ` +
      `${plural(streams.length, 'AES67 stream')}.`,
    series: { metric: 'media.mdnsDevices', key: '' },
  })

  return { id: 'media', label: 'Audio & media network', grade: worstFinding(findings), findings }
}

// -- probe plumbing -----------------------------------------------------------

interface ProbeResultLike {
  id: string
  state: FindingState | 'skipped'
  detail: string
  fix?: string
}

function probeResults(run: ProbeRunRecord | null): ProbeResultLike[] {
  if (!run || !run.finishedAt) return []
  const report = run.report as { probes?: ProbeResultLike[] } | null
  return Array.isArray(report?.probes) ? report.probes : []
}
