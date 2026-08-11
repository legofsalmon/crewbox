import type { GdtfChannel } from './gdtf'

/**
 * The lighting module's domain types.
 *
 * A lighting plot is one row per fixture with fixed columns — flat, unlike a
 * patch sheet's channels × acts grid. The field set is deliberately a
 * crew-and-ops one: get it rigged, powered, addressed, and checked. Gel,
 * gobo, and focus notes are the designer's paperwork and are out of scope;
 * `notes` carries anything that doesn't fit.
 */

/** Where a fixture is in the systems-check workflow. */
export type FixtureStatus = 'todo' | 'rigged' | 'ok' | 'fault'

export const FIXTURE_STATUSES: FixtureStatus[] = ['todo', 'rigged', 'ok', 'fault']

export const FIXTURE_STATUS_LABELS: Record<FixtureStatus, string> = {
  todo: 'To do',
  rigged: 'Rigged',
  ok: 'Working',
  fault: 'Fault',
}

export type PositionKind = 'truss' | 'bar' | 'boom' | 'floor' | 'other'

export const POSITION_KINDS: PositionKind[] = ['truss', 'bar', 'boom', 'floor', 'other']

export const POSITION_KIND_LABELS: Record<PositionKind, string> = {
  truss: 'Truss',
  bar: 'Bar',
  boom: 'Boom',
  floor: 'Floor',
  other: 'Other',
}

/**
 * A rigging position — a truss, bar, boom, or floor package. Doubles as the
 * plot's geometry: drawn as a line segment of `length` metres centred on
 * (x, y) and turned `rotation` degrees.
 */
export interface Position {
  id: string
  name: string
  kind: PositionKind
  /** Plan coordinates in metres. x runs stage-left→right, y runs upstage. */
  x: number
  y: number
  /**
   * Trim height in metres above the deck — where the bar hangs, and the
   * only thing that makes a front elevation say anything. A boom reads it
   * as its own height rather than a hanging height, since a boom stands up
   * off the floor instead of flying.
   */
  z: number
  /** Length in metres. */
  length: number
  /** Degrees clockwise from horizontal (0 = across the stage). */
  rotation: number
}

/**
 * One fixture in the rig. `address` is the DMX start address within
 * `universe`; the fixture occupies `footprint` consecutive channels from
 * there, which is what makes overlap detection possible.
 *
 * `channel` is the desk's control channel, which is a different number from
 * the DMX address and is what everyone actually says out loud ("channel 101
 * is dark").
 */
export interface Fixture {
  id: string
  // --- Core patch
  /** Desk control channel. Empty when unpatched on the desk. */
  channel: string
  universe: number
  /** DMX start address, 1–512. 0 means not addressed yet. */
  address: number
  /** Fixture type id — a built-in, a plot-local custom type, or '' for none. */
  typeId: string
  /** Mode name within the type; free text when the type is unknown. */
  mode: string
  /** DMX channels occupied. Seeded from the type's mode, editable per fixture. */
  footprint: number
  purpose: string
  // --- Rigging
  positionId: string
  /** Unit number on its position — orders fixtures along the bar in the plot. */
  unit: string
  circuit: string
  /** Watts. Null when unknown; the position totals skip it. */
  watts: number | null
  /** Kilograms. Null when unknown. */
  weight: number | null
  /**
   * Real plan coordinates in metres, when something authoritative supplied
   * them (MVR does). Null means "place me along my position", which is what
   * hand-built plots do.
   */
  x: number | null
  y: number | null
  /** Real height above the deck, same story. Null means "my position's trim". */
  z: number | null
  // --- Ops
  notes: string
  status: FixtureStatus
}

export interface FixtureMode {
  name: string
  footprint: number
  /**
   * What each channel of this mode does, from the manufacturer's GDTF
   * profile. Present only for modes an MVR import found in use — the live
   * view degrades to peak-in-footprint without it, which is what a
   * hand-typed fixture gets anyway.
   */
  channels?: GdtfChannel[]
}

/**
 * A fixture type: a name and the modes it can be patched in. Built-ins are
 * seeds (see fixtures.ts); crews add their own, which sync with the plot.
 */
export interface FixtureType {
  id: string
  name: string
  modes: FixtureMode[]
  watts?: number
  weight?: number
  /**
   * Space it takes along a bar, in metres — used to work out how much truss
   * a run of fixtures needs. Optional: `truss.ts` falls back to a sensible
   * default for a type whose profile doesn't say.
   */
  width?: number
  /** Overall height in metres, from the GDTF models. */
  height?: number
  /** Beam angle in degrees, for drawing beams in the 3D view. */
  beamAngle?: number
}

export interface PlotMeta {
  title: string
  venue: string
  date: string
  notes: string
}

export interface PlotSnapshot {
  meta: PlotMeta
  positions: Position[]
  fixtures: Fixture[]
  /** Fixture types defined in this plot, on top of the built-ins. */
  customTypes: FixtureType[]
}

export const DMX_UNIVERSE_SIZE = 512

export const emptyFixture = (): Omit<Fixture, 'id'> => ({
  channel: '',
  universe: 1,
  address: 0,
  typeId: '',
  mode: '',
  footprint: 1,
  purpose: '',
  positionId: '',
  unit: '',
  circuit: '',
  watts: null,
  weight: null,
  x: null,
  y: null,
  z: null,
  notes: '',
  status: 'todo',
})

/** Columns the fixture list shows, in order. */
export const FIXTURE_COLUMNS = [
  'channel',
  'universe',
  'address',
  'type',
  'mode',
  'footprint',
  'purpose',
  'position',
  'unit',
  'circuit',
  'watts',
  'weight',
  'status',
  'notes',
] as const

export type FixtureColumn = (typeof FIXTURE_COLUMNS)[number]

export const FIXTURE_COLUMN_LABELS: Record<FixtureColumn, string> = {
  channel: 'Chan',
  universe: 'Uni',
  address: 'Addr',
  type: 'Type',
  mode: 'Mode',
  footprint: 'Ch',
  purpose: 'Purpose',
  position: 'Position',
  unit: 'Unit',
  circuit: 'Circuit',
  watts: 'W',
  weight: 'kg',
  status: 'Status',
  notes: 'Notes',
}
