import { useMemo } from 'react'
import { useStore } from '../../../store.ts'
import { fixtureColour, fixtureIntensity, fixtureOrientation } from '../model/gdtfLive'
import type { PlotSnapshot } from '../model/types'

/**
 * How each fixture should be drawn right now, given what the wire is saying.
 *
 * The plan, the elevation and the 3D view all draw the same rig and have to
 * agree about it — three separate reads of the level map would drift apart
 * the moment one of them was changed. This computes it once.
 *
 * It is deliberately a whole-plot map rather than a per-fixture hook: the
 * levels only change when the lighting network does something new, so a
 * memo keyed on that recomputes at most a few times a second for the whole
 * rig, and not at all when nobody is watching.
 */

export interface LiveLook {
  /** Opacity to draw the fixture at, 0.25–1. */
  dim: number
  /** Whether `dim` is a real dimmer channel or the peak in the footprint. */
  basis: 'dimmer' | 'peak'
  /** CSS colour the fixture is being asked for, when the profile says. */
  colour: string | null
  /** Degrees, for drawing a beam. Null for anything that doesn't move. */
  pan: number | null
  tilt: number | null
}

/** Null when levels aren't being watched — draw the plot as paperwork. */
export function useLiveLook(snapshot: PlotSnapshot): Map<string, LiveLook> | null {
  const levels = useStore((s) => (s.dmx.listening ? s.dmx.levels : null))

  return useMemo(() => {
    if (!levels || levels.size === 0) return null
    const look = new Map<string, LiveLook>()
    for (const fixture of snapshot.fixtures) {
      const intensity = fixtureIntensity(fixture, snapshot.customTypes, levels)
      if (!intensity) continue
      const orientation = fixtureOrientation(fixture, snapshot.customTypes, levels)
      look.set(fixture.id, {
        dim: 0.25 + 0.75 * intensity.level,
        basis: intensity.basis,
        colour: fixtureColour(fixture, snapshot.customTypes, levels)?.css ?? null,
        pan: orientation?.pan ?? null,
        tilt: orientation?.tilt ?? null,
      })
    }
    return look
  }, [levels, snapshot.fixtures, snapshot.customTypes])
}
