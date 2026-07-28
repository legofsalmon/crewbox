import { newId } from '@crewbox/shared'
import * as Y from 'yjs'
import { DEFAULT_TRIM } from './geometry'
import {
  emptyFixture,
  type Fixture,
  type FixtureStatus,
  type FixtureType,
  type PlotMeta,
  type PlotSnapshot,
  type Position,
  type PositionKind,
} from './types'

/**
 * Y.Doc structure and operations for a lighting plot.
 *
 * Fixtures live in a Y.Array of Y.Maps rather than a Y.Map keyed by id,
 * because order is meaningful — the list is the paperwork, and crew expect
 * it to stay in the order they built it. Positions are the same. Each
 * fixture is a Y.Map so two people editing different fields of the same
 * fixture merge cleanly instead of clobbering each other.
 */

export const LOCAL_ORIGIN = 'lighting-local'

type YEntity = Y.Map<unknown>

export interface PlotRoots {
  meta: Y.Map<unknown>
  positions: Y.Array<YEntity>
  fixtures: Y.Array<YEntity>
  types: Y.Array<YEntity>
}

export const getPlotRoots = (doc: Y.Doc): PlotRoots => ({
  meta: doc.getMap('meta'),
  positions: doc.getArray<YEntity>('positions'),
  fixtures: doc.getArray<YEntity>('fixtures'),
  types: doc.getArray<YEntity>('types'),
})

const mapFrom = (obj: Record<string, unknown>): YEntity => {
  const map = new Y.Map<unknown>()
  for (const [k, v] of Object.entries(obj)) map.set(k, v)
  return map
}

const transact = (doc: Y.Doc, fn: () => void) => doc.transact(fn, LOCAL_ORIGIN)

const findById = (arr: Y.Array<YEntity>, id: string): { item: YEntity; index: number } | null => {
  for (let i = 0; i < arr.length; i++) {
    const item = arr.get(i)
    if (item.get('id') === id) return { item, index: i }
  }
  return null
}

/**
 * Undo/redo across the whole plot, tracking ONLY this client's edits. Remote
 * updates arrive with other origins and are never undone — you take back
 * your own change, not a collaborator's.
 */
export const createPlotUndoManager = (doc: Y.Doc): Y.UndoManager =>
  new Y.UndoManager(Object.values(getPlotRoots(doc)) as Y.AbstractType<unknown>[], {
    trackedOrigins: new Set([LOCAL_ORIGIN]),
    captureTimeout: 300,
  })

// --- Creation ---------------------------------------------------------------

export interface InitPlotOptions {
  title: string
  venue?: string
  date?: string
}

/** Give a new plot its baseline: meta and one position to hang things on. */
export const initPlot = (doc: Y.Doc, options: InitPlotOptions): void => {
  const { meta, positions } = getPlotRoots(doc)
  transact(doc, () => {
    meta.set('title', options.title)
    meta.set('venue', options.venue ?? '')
    meta.set('date', options.date ?? '')
    meta.set('notes', '')
    if (positions.length === 0) {
      positions.push([
        mapFrom({
          id: newId(),
          name: 'Upstage Truss',
          kind: 'truss' satisfies PositionKind,
          x: 0,
          y: 6,
          z: DEFAULT_TRIM.truss,
          length: 12,
          rotation: 0,
        }),
      ])
    }
  })
}

// --- Meta -------------------------------------------------------------------

export const setPlotMeta = (doc: Y.Doc, field: keyof PlotMeta, value: string): void => {
  const { meta } = getPlotRoots(doc)
  transact(doc, () => meta.set(field, value))
}

// --- Positions --------------------------------------------------------------

export const addPosition = (doc: Y.Doc, name: string, kind: PositionKind = 'truss'): string => {
  const { positions } = getPlotRoots(doc)
  const id = newId()
  transact(doc, () => {
    positions.push([
      mapFrom({
        id,
        name,
        kind,
        x: 0,
        // Stack new positions upstage of each other so they don't land on top
        // of one another in the plot before anyone has placed them.
        y: 2 + positions.length * 2,
        z: DEFAULT_TRIM[kind],
        length: 12,
        rotation: 0,
      }),
    ])
  })
  return id
}

export const updatePosition = (
  doc: Y.Doc,
  positionId: string,
  fields: Partial<Omit<Position, 'id'>>
): void => {
  const { positions } = getPlotRoots(doc)
  const found = findById(positions, positionId)
  if (!found) return
  transact(doc, () => {
    for (const [key, value] of Object.entries(fields)) found.item.set(key, value)
  })
}

/**
 * Remove a position. Fixtures on it aren't deleted — they lose their
 * position and drop to the unassigned group, because a truss coming out of
 * the rig doesn't mean its fixtures stopped existing.
 */
export const removePosition = (doc: Y.Doc, positionId: string): void => {
  const { positions, fixtures } = getPlotRoots(doc)
  const found = findById(positions, positionId)
  if (!found) return
  transact(doc, () => {
    positions.delete(found.index, 1)
    for (let i = 0; i < fixtures.length; i++) {
      const fixture = fixtures.get(i)
      if (fixture.get('positionId') === positionId) fixture.set('positionId', '')
    }
  })
}

// --- Fixtures ---------------------------------------------------------------

export const addFixture = (doc: Y.Doc, fields: Partial<Omit<Fixture, 'id'>> = {}): string => {
  const { fixtures } = getPlotRoots(doc)
  const id = newId()
  transact(doc, () => {
    fixtures.push([mapFrom({ id, ...emptyFixture(), ...fields })])
  })
  return id
}

/** Append several fixtures in one transaction — one undo step for a bulk add. */
export const addFixtures = (doc: Y.Doc, rows: Partial<Omit<Fixture, 'id'>>[]): string[] => {
  const { fixtures } = getPlotRoots(doc)
  const ids: string[] = []
  transact(doc, () => {
    const entities = rows.map((row) => {
      const id = newId()
      ids.push(id)
      return mapFrom({ id, ...emptyFixture(), ...row })
    })
    if (entities.length > 0) fixtures.push(entities)
  })
  return ids
}

export const updateFixture = (
  doc: Y.Doc,
  fixtureId: string,
  fields: Partial<Omit<Fixture, 'id'>>
): void => {
  const { fixtures } = getPlotRoots(doc)
  const found = findById(fixtures, fixtureId)
  if (!found) return
  transact(doc, () => {
    for (const [key, value] of Object.entries(fields)) found.item.set(key, value)
  })
}

export const removeFixture = (doc: Y.Doc, fixtureId: string): void => {
  const { fixtures } = getPlotRoots(doc)
  const found = findById(fixtures, fixtureId)
  if (!found) return
  transact(doc, () => fixtures.delete(found.index, 1))
}

export const setFixtureStatus = (doc: Y.Doc, fixtureId: string, status: FixtureStatus): void =>
  updateFixture(doc, fixtureId, { status })

/**
 * Re-address a run of fixtures from a start address, packing them nose to
 * tail by footprint. This is the bulk operation that actually saves time on
 * site: select a truss, "address from 1", done.
 */
export const addressSequentially = (
  doc: Y.Doc,
  fixtureIds: string[],
  universe: number,
  startAddress: number
): void => {
  const { fixtures } = getPlotRoots(doc)
  transact(doc, () => {
    let cursor = startAddress
    for (const id of fixtureIds) {
      const found = findById(fixtures, id)
      if (!found) continue
      const footprint = Number(found.item.get('footprint')) || 1
      found.item.set('universe', universe)
      found.item.set('address', cursor)
      cursor += footprint
    }
  })
}

// --- Custom fixture types ---------------------------------------------------

export const addFixtureType = (doc: Y.Doc, type: Omit<FixtureType, 'id'>): string => {
  const { types } = getPlotRoots(doc)
  const id = newId()
  transact(doc, () => {
    types.push([mapFrom({ id, ...type, modes: type.modes.map((m) => ({ ...m })) })])
  })
  return id
}

/**
 * Add or replace a type under an id the caller owns. MVR keys types by their
 * GDTF filename, and fixtures reference that same string, so minting a new
 * id here would leave every imported fixture pointing at a type that isn't
 * in the list. Re-importing the same rig updates rather than duplicates.
 */
export const upsertFixtureType = (doc: Y.Doc, type: FixtureType): void => {
  const { types } = getPlotRoots(doc)
  const entity = () => mapFrom({ ...type, modes: type.modes.map((m) => ({ ...m })) })
  const found = findById(types, type.id)
  transact(doc, () => {
    if (found) {
      types.delete(found.index, 1)
      types.insert(found.index, [entity()])
    } else {
      types.push([entity()])
    }
  })
}

export const removeFixtureType = (doc: Y.Doc, typeId: string): void => {
  const { types } = getPlotRoots(doc)
  const found = findById(types, typeId)
  if (!found) return
  transact(doc, () => types.delete(found.index, 1))
}

// --- Snapshot ---------------------------------------------------------------

const num = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

const nullableNum = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * Plain-object view of the doc for rendering. Every field is read
 * defensively: a doc can arrive from a peer running an older build, and a
 * missing field should degrade to a sensible default rather than crash the
 * list someone is standing under a truss reading.
 */
export const snapshotPlot = (doc: Y.Doc): PlotSnapshot => {
  const { meta, positions, fixtures, types } = getPlotRoots(doc)

  return {
    meta: {
      title: str(meta.get('title')) || 'Untitled Plot',
      venue: str(meta.get('venue')),
      date: str(meta.get('date')),
      notes: str(meta.get('notes')),
    },
    positions: positions.map((item): Position => {
      const json = item.toJSON() as Record<string, unknown>
      const kind = (['truss', 'bar', 'boom', 'floor', 'other'] as const).includes(
        json.kind as PositionKind
      )
        ? (json.kind as PositionKind)
        : 'other'
      return {
        id: str(json.id),
        name: str(json.name),
        kind,
        x: num(json.x, 0),
        y: num(json.y, 0),
        // Plots built before trim heights existed have no z at all. Falling
        // back to the kind's default gives them a sensible elevation the
        // first time someone opens one, rather than a rig lying on the deck.
        z: num(json.z, DEFAULT_TRIM[kind]),
        length: num(json.length, 12),
        rotation: num(json.rotation, 0),
      }
    }),
    fixtures: fixtures.map((item): Fixture => {
      const json = item.toJSON() as Record<string, unknown>
      const status = json.status
      return {
        id: str(json.id),
        channel: str(json.channel),
        universe: Math.max(1, num(json.universe, 1)),
        address: Math.max(0, num(json.address, 0)),
        typeId: str(json.typeId),
        mode: str(json.mode),
        footprint: Math.max(0, num(json.footprint, 1)),
        purpose: str(json.purpose),
        positionId: str(json.positionId),
        unit: str(json.unit),
        circuit: str(json.circuit),
        watts: nullableNum(json.watts),
        weight: nullableNum(json.weight),
        x: nullableNum(json.x),
        y: nullableNum(json.y),
        z: nullableNum(json.z),
        notes: str(json.notes),
        status: (['todo', 'rigged', 'ok', 'fault'] as const).includes(status as FixtureStatus)
          ? (status as FixtureStatus)
          : 'todo',
      }
    }),
    customTypes: types.map((item): FixtureType => {
      const json = item.toJSON() as Record<string, unknown>
      const modes = Array.isArray(json.modes) ? json.modes : []
      return {
        id: str(json.id),
        name: str(json.name),
        modes: modes
          .filter((mode): mode is Record<string, unknown> => !!mode && typeof mode === 'object')
          .map((mode) => ({ name: str(mode.name), footprint: num(mode.footprint, 1) })),
        watts: nullableNum(json.watts) ?? undefined,
        weight: nullableNum(json.weight) ?? undefined,
        width: nullableNum(json.width) ?? undefined,
      }
    }),
  }
}

/** Fixtures on a position, ordered by unit number (numeric where it can be). */
export const fixturesOnPosition = (snapshot: PlotSnapshot, positionId: string): Fixture[] =>
  snapshot.fixtures
    .filter((fixture) => fixture.positionId === positionId)
    .sort((a, b) => {
      const [na, nb] = [Number(a.unit), Number(b.unit)]
      if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb
      return a.unit.localeCompare(b.unit, undefined, { numeric: true })
    })
