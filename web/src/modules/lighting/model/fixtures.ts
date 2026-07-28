import type { FixtureMode, FixtureType } from './types'

/**
 * Seed fixture library.
 *
 * Footprints drive collision detection, so a wrong one here produces
 * confidently wrong warnings — worse than no warnings at all. That argues
 * for a small, honest list rather than a broad half-remembered one, so the
 * library leads with generic profiles by channel count (which is how crew
 * think about it when patching anyway: "it's in 16-channel mode") and names
 * only fixtures whose modes are stable and well known.
 *
 * The real library is the one a crew builds: custom types live in the plot
 * and sync to everyone on it. Every fixture's footprint is editable
 * regardless of its type, so an unusual mode never blocks anyone.
 */

export const BUILTIN_FIXTURE_TYPES: FixtureType[] = [
  {
    id: 'conventional',
    width: 0.3,
    name: 'Conventional / dimmer',
    modes: [{ name: '1 ch', footprint: 1 }],
  },
  {
    id: 'led-par',
    width: 0.3,
    name: 'LED PAR (generic)',
    modes: [
      { name: 'RGB (3 ch)', footprint: 3 },
      { name: 'RGBW (4 ch)', footprint: 4 },
      { name: 'RGBWA+UV (6 ch)', footprint: 6 },
      { name: '8 ch', footprint: 8 },
    ],
  },
  {
    id: 'led-batten',
    width: 1,
    name: 'LED batten / bar (generic)',
    modes: [
      { name: '4 ch', footprint: 4 },
      { name: '8 ch', footprint: 8 },
      { name: '12 ch', footprint: 12 },
      { name: '16 ch', footprint: 16 },
    ],
  },
  {
    id: 'moving-wash',
    width: 0.4,
    name: 'Moving wash (generic)',
    modes: [
      { name: '12 ch', footprint: 12 },
      { name: '14 ch', footprint: 14 },
      { name: '16 ch', footprint: 16 },
      { name: '20 ch', footprint: 20 },
      { name: '24 ch', footprint: 24 },
    ],
  },
  {
    id: 'moving-spot',
    width: 0.4,
    name: 'Moving spot / beam (generic)',
    modes: [
      { name: '16 ch', footprint: 16 },
      { name: '20 ch', footprint: 20 },
      { name: '24 ch', footprint: 24 },
      { name: '32 ch', footprint: 32 },
      { name: '38 ch', footprint: 38 },
    ],
  },
  {
    id: 'strobe',
    width: 0.4,
    name: 'Strobe (generic)',
    modes: [
      { name: '2 ch', footprint: 2 },
      { name: '4 ch', footprint: 4 },
      { name: '10 ch', footprint: 10 },
    ],
  },
  {
    id: 'hazer',
    width: 0.5,
    name: 'Hazer / fogger (generic)',
    modes: [
      { name: '1 ch', footprint: 1 },
      { name: '2 ch', footprint: 2 },
      { name: '4 ch', footprint: 4 },
    ],
  },
  {
    id: 'claypaky-sharpy',
    width: 0.36,
    name: 'Clay Paky Sharpy',
    modes: [{ name: 'Standard', footprint: 16 }],
  },
  {
    id: 'robe-pointe',
    width: 0.4,
    name: 'Robe Robin Pointe',
    modes: [
      { name: 'Mode 1', footprint: 24 },
      { name: 'Mode 2', footprint: 34 },
    ],
  },
]

/** Built-ins plus this plot's own types, built-ins first. */
export const allFixtureTypes = (customTypes: FixtureType[]): FixtureType[] => [
  ...BUILTIN_FIXTURE_TYPES,
  ...customTypes,
]

export const findFixtureType = (
  typeId: string,
  customTypes: FixtureType[]
): FixtureType | undefined => allFixtureTypes(customTypes).find((type) => type.id === typeId)

export const findMode = (
  type: FixtureType | undefined,
  modeName: string
): FixtureMode | undefined => type?.modes.find((mode) => mode.name === modeName)

/**
 * Footprint implied by a type and mode, or null when nothing says. Callers
 * seed a fixture with this and then leave the fixture's own value alone —
 * someone who typed a footprint meant it.
 */
export const footprintFor = (
  typeId: string,
  modeName: string,
  customTypes: FixtureType[]
): number | null => {
  const type = findFixtureType(typeId, customTypes)
  if (!type) return null
  const mode = findMode(type, modeName)
  if (mode) return mode.footprint
  // One-mode types don't need the mode spelled out.
  return type.modes.length === 1 ? type.modes[0]!.footprint : null
}

/** Match a type by name for CSV import — exact first, then case-insensitive. */
export const matchTypeByName = (
  name: string,
  customTypes: FixtureType[]
): FixtureType | undefined => {
  const trimmed = name.trim()
  if (!trimmed) return undefined
  const types = allFixtureTypes(customTypes)
  return (
    types.find((type) => type.name === trimmed) ??
    types.find((type) => type.name.toLowerCase() === trimmed.toLowerCase())
  )
}
