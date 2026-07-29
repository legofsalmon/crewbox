import type { ReadinessCheck } from '../readiness.ts'
import type { DmxListenerStatus } from './listener.ts'
import type { UniverseHealth } from './state.ts'
import { ARTNET_MERGE_SOURCES } from './types.ts'

/**
 * "Lighting network", beside "This box" and "This network".
 *
 * Same rule as those two: say what is true right now, and attach the fix to
 * anything that isn't. The distinction that earns this panel its place is
 * between **not listening**, **listening and nothing arriving**, and
 * **listening and here is what is on the wire** — three states that look
 * identical from inside the app and have completely different causes.
 */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const ago = (now: number, then: number): string => {
  const secs = Math.round((now - then) / 1000)
  if (secs < 2) return 'just now'
  if (secs < 90) return `${secs}s ago`
  return `${Math.round(secs / 60)} min ago`
}

export function dmxReadiness(
  status: DmxListenerStatus,
  universes: UniverseHealth[],
  now: number
): ReadinessCheck[] {
  if (status.mode === 'off') {
    return [
      {
        id: 'dmx-off',
        label: 'Lighting network',
        state: 'off',
        detail: 'Not listening. Crewbox is not connected to Art-Net or sACN.',
        fix: 'Set CREWBOX_DMX=both and restart, with the box on the lighting network.',
      },
    ]
  }

  const checks: ReadinessCheck[] = []
  const live = universes.filter((u) => u.sources.length > 0)

  // --- Are the sockets even open ------------------------------------------
  if (status.mode !== 'sacn') {
    checks.push(
      status.artnet.listening
        ? {
            id: 'dmx-artnet',
            label: 'Art-Net',
            state: 'ok',
            detail: 'Listening on UDP 6454 for broadcast Art-Net.',
          }
        : {
            id: 'dmx-artnet',
            label: 'Art-Net',
            state: 'limited',
            detail: status.artnet.error ?? 'Not listening.',
            fix: 'Something else may already hold UDP 6454 on this machine.',
          }
    )
  }

  if (status.mode !== 'artnet') {
    const { joined, failed, listening, error } = status.sacn
    if (!listening) {
      checks.push({
        id: 'dmx-sacn',
        label: 'sACN',
        state: 'limited',
        detail: error ?? 'Not listening.',
        fix: 'Something else may already hold UDP 5568 on this machine.',
      })
    } else if (failed.length > 0) {
      checks.push({
        id: 'dmx-sacn',
        label: 'sACN',
        state: 'limited',
        detail: `Joined ${plural(joined.length, 'universe')}; could not join ${failed
          .map((f) => f.universe)
          .join(', ')}.`,
        fix: 'Linux allows 20 multicast memberships per socket — listen to fewer universes, or raise net.ipv4.igmp_max_memberships.',
      })
    } else {
      checks.push({
        id: 'dmx-sacn',
        label: 'sACN',
        state: 'ok',
        detail:
          `Listening on UDP 5568, joined ${plural(joined.length, 'universe')}` +
          (status.interfaceIp ? ` via ${status.interfaceIp}.` : ' via the default route.'),
        fix: status.interfaceIp
          ? undefined
          : 'On a box with more than one network card, set CREWBOX_DMX_IFACE or the groups may be joined on the wrong one.',
      })
    }
  }

  // --- Is anything actually arriving --------------------------------------
  if (live.length === 0) {
    checks.push({
      id: 'dmx-traffic',
      label: 'Lighting data',
      state: 'limited',
      detail:
        status.packets > 0
          ? `Nothing arriving now. ${plural(status.packets, 'packet')} seen since start.`
          : 'Listening, but nothing has arrived.',
      fix: 'Check the box is on the lighting network (right card, right VLAN), that the switch is not doing IGMP snooping without a querier, and that no firewall is dropping UDP 6454/5568. Crewbox never announces itself, so a console that only unicasts to nodes which answered its poll will not be seen.',
    })
    return checks
  }

  // --- What is on the wire -------------------------------------------------
  const conflicts = live.filter((u) => u.conflict)
  const sources = new Set(live.flatMap((u) => u.sources.map((s) => s.id)))
  const names = [
    ...new Set(live.flatMap((u) => u.sources.map((s) => s.name).filter(Boolean))),
  ].slice(0, 3)

  checks.push({
    id: 'dmx-traffic',
    label: 'Lighting data',
    state: 'ok',
    detail:
      `${plural(live.length, 'universe')} live from ${plural(sources.size, 'source')}` +
      (names.length > 0 ? ` (${names.join(', ')})` : '') +
      `, last seen ${ago(now, Math.max(...live.map((u) => u.lastSeen)))}.`,
  })

  // Two sources at one priority is the fault worth shouting about: what a
  // receiver does about it is not settled between them, so it runs a whole
  // show unnoticed.
  if (conflicts.length > 0) {
    const crowded = conflicts.some(
      (u) => u.protocol === 'artnet' && u.sources.length > ARTNET_MERGE_SOURCES
    )
    checks.push({
      id: 'dmx-conflict',
      label: 'Two sources on one universe',
      state: 'limited',
      detail: conflicts
        .map(
          (u) =>
            `Universe ${u.universe}: ${u.sources.map((s) => s.name || s.id.slice(0, 8)).join(' and ')} all at priority ${Math.max(...u.sources.map((s) => s.priority))}`
        )
        .join('; '),
      fix:
        'Crewbox shows one of them and cannot merge, so the rig may look fine here and behave oddly on stage. Unpatch one, or give them different priorities.' +
        // The extra sources are not merged more aggressively — they are
        // dropped, so one of these consoles is doing nothing at all.
        (crowded
          ? ` An Art-Net node merges at most ${ARTNET_MERGE_SOURCES} sources and ignores any beyond that, so one of these is being discarded entirely.`
          : ''),
    })
  }

  // --- Is what we can see what is on stage ---------------------------------
  //
  // A synchronised rig whose sync stream has died is the nastiest fault in
  // this whole panel: the desk keeps sending, crewbox keeps showing levels
  // changing, and the stage has not moved since the stream stopped.
  const stuck = live.filter((u) => u.sync === 'frozen' || u.sync === 'lost')
  const held = live.filter((u) => u.sync === 'held')
  const unwatched = live.filter((u) => u.sync === 'unwatched')

  if (stuck.length > 0) {
    const frozen = stuck.some((u) => u.sync === 'frozen')
    checks.push({
      id: 'dmx-sync',
      label: 'Universe synchronisation',
      state: 'limited',
      detail:
        `${plural(stuck.length, 'universe')} asking to be synchronised on universe ` +
        `${[...new Set(stuck.map((u) => u.syncAddress))].join(', ')}, but nothing is ` +
        `arriving there.` +
        (frozen
          ? ' Receivers hold their last look until it comes back, so the stage may have stopped following the desk.'
          : ' The sources allow receivers to carry on, so the stage is live but no longer synchronised.'),
      fix: 'Check what is meant to be sending synchronization packets on that universe. Until it is back, levels shown here are not proof of what is on stage.',
    })
  } else if (unwatched.length > 0) {
    checks.push({
      id: 'dmx-sync',
      label: 'Universe synchronisation',
      state: 'limited',
      detail:
        `${plural(unwatched.length, 'universe')} synchronised on universe ` +
        `${[...new Set(unwatched.map((u) => u.syncAddress))].join(', ')}, which this box is ` +
        'not listening to — so whether those levels have reached the stage is unknown.',
      fix: `Add ${[...new Set(unwatched.map((u) => u.syncAddress))].join(',')} to CREWBOX_DMX_UNIVERSES and restart.`,
    })
  } else if (held.length > 0) {
    checks.push({
      id: 'dmx-sync',
      label: 'Universe synchronisation',
      state: 'ok',
      detail:
        `${plural(held.length, 'universe')} synchronised and the stream is arriving. ` +
        'Levels shown are queued for the next synchronization packet rather than already on stage.',
    })
  }

  // The universe mapping, stated rather than assumed — a wrong Art-Net base
  // moves every fixture by 512 channels and looks like nothing at all.
  const artnet = live.filter((u) => u.protocol === 'artnet')
  if (artnet.length > 0) {
    checks.push({
      id: 'dmx-mapping',
      label: 'Universe mapping',
      state: 'ok',
      detail: artnet
        .slice(0, 6)
        .map((u) => `Art-Net ${u.wireUniverse} → plot universe ${u.universe}`)
        .join(', '),
      fix: 'If your console numbers these differently, set CREWBOX_DMX_ARTNET_BASE — otherwise every fixture will be checked against the wrong universe.',
    })
  }

  return checks
}
