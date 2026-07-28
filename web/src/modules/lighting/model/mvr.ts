import { unzipSync } from 'fflate'
import { DMX_UNIVERSE_SIZE, type FixtureMode, type FixtureType } from './types'

/**
 * MVR (My Virtual Rig) import.
 *
 * An .mvr is a ZIP holding `GeneralSceneDescription.xml` plus the .gdtf file
 * for every fixture type the rig uses. That makes it a far better source
 * than any CSV: a spreadsheet tells you what someone typed, while MVR
 * carries the fixture's own DMX mode definition, so the footprint that
 * drives collision detection comes from the manufacturer's profile rather
 * than from a guess.
 *
 * It also carries real coordinates, so the plot comes out placed instead of
 * evenly spaced on a default truss.
 *
 * Everything here is defensive. These files come out of Vectorworks, MA and
 * Capture, they are large, and a rig sheet that half-imports with a clear
 * warning beats one that throws on an attribute someone's exporter spells
 * differently.
 */

export interface MvrFixture {
  name: string
  /** Layer or group the fixture sat in — becomes a rigging position. */
  layer: string
  /** Fixture type id, keyed by GDTF spec filename. */
  typeId: string
  mode: string
  footprint: number
  universe: number
  address: number
  /** MVR FixtureID — the desk channel. */
  channel: string
  unit: string
  /** Plan coordinates in metres (MVR works in millimetres). */
  x: number
  y: number
  /** Height above the deck in metres — the trim, straight from the file. */
  z: number
}

export interface MvrResult {
  fixtures: MvrFixture[]
  /** Fixture types built from the embedded GDTF profiles. */
  types: FixtureType[]
  /** Non-fatal problems worth showing the person doing the import. */
  warnings: string[]
}

const textOf = (parent: Element, tag: string): string =>
  parent.getElementsByTagName(tag)[0]?.textContent?.trim() ?? ''

const parseXml = (text: string, what: string): Document => {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  const error = doc.getElementsByTagName('parsererror')[0]
  if (error) throw new Error(`${what} is not valid XML`)
  return doc
}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

/** ZIP entry lookup that tolerates case and directory prefixes. */
const findEntry = (
  files: Record<string, Uint8Array>,
  predicate: (name: string) => boolean
): Uint8Array | undefined => {
  const key = Object.keys(files).find((name) => predicate(name.toLowerCase()))
  return key === undefined ? undefined : files[key]
}

/**
 * `{1,0,0}{0,1,0}{0,0,1}{-3000,6000,8000}` — three basis vectors then the
 * translation, in millimetres. Only the translation matters for a plan.
 */
export const parseMvrMatrix = (text: string): { x: number; y: number; z: number } | null => {
  const groups = text.match(/\{[^}]*\}/g)
  if (!groups || groups.length < 4) return null
  const parts = groups[groups.length - 1]!.slice(1, -1)
    .split(',')
    .map((n) => Number(n.trim()))
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null
  return { x: parts[0]! / 1000, y: parts[1]! / 1000, z: parts[2]! / 1000 }
}

/**
 * DMX footprint of a GDTF mode: the highest channel offset it uses.
 *
 * Offsets are 1-based and comma-separated for multi-byte channels ("1,2" is
 * a 16-bit channel occupying 1 and 2). Channels with no Offset are virtual
 * and occupy nothing.
 *
 * Multi-break fixtures (separate address blocks) are collapsed to their
 * widest break, which overstates a rare case rather than understating it —
 * for collision detection, claiming too much is the safe direction.
 */
export const gdtfModeFootprint = (mode: Element): number => {
  let max = 0
  const channels = mode.getElementsByTagName('DMXChannel')
  for (let i = 0; i < channels.length; i++) {
    const offset = channels[i]!.getAttribute('Offset')
    if (!offset || offset.toLowerCase() === 'none') continue
    for (const part of offset.split(',')) {
      const value = Number(part.trim())
      if (Number.isFinite(value) && value > max) max = value
    }
  }
  return max
}

/** Build a crewbox fixture type from an embedded .gdtf archive. */
const typeFromGdtf = (id: string, gdtfBytes: Uint8Array): FixtureType | null => {
  const inner = unzipSync(gdtfBytes)
  const descriptionBytes = findEntry(inner, (name) => name.endsWith('description.xml'))
  if (!descriptionBytes) return null

  const doc = parseXml(decode(descriptionBytes), 'GDTF description')
  const fixtureType = doc.getElementsByTagName('FixtureType')[0]
  if (!fixtureType) return null

  const manufacturer = fixtureType.getAttribute('Manufacturer')?.trim() ?? ''
  const name = fixtureType.getAttribute('Name')?.trim() ?? id
  const modeElements = doc.getElementsByTagName('DMXMode')

  const modes: FixtureMode[] = []
  for (let i = 0; i < modeElements.length; i++) {
    const element = modeElements[i]!
    const footprint = gdtfModeFootprint(element)
    if (footprint > 0) {
      modes.push({ name: element.getAttribute('Name')?.trim() || `Mode ${i + 1}`, footprint })
    }
  }
  if (modes.length === 0) return null

  return {
    id,
    name: manufacturer && !name.startsWith(manufacturer) ? `${manufacturer} ${name}` : name,
    modes,
  }
}

/** MVR writes 0 for an unassigned FixtureID or UnitNumber. */
const unsetZero = (value: string): string => (value === '0' ? '' : value)

/** Absolute MVR address → universe and in-universe address. */
const splitAddress = (absolute: number): { universe: number; address: number } => ({
  universe: Math.floor((absolute - 1) / DMX_UNIVERSE_SIZE) + 1,
  address: ((absolute - 1) % DMX_UNIVERSE_SIZE) + 1,
})

/**
 * Walk a ChildList, collecting fixtures. Groups nest arbitrarily deep and
 * exporters use them for real structure, so a group's name wins over the
 * layer's as the position — "SL Boom" is more useful than "Layer 1".
 */
const collectFixtures = (
  node: Element,
  groupName: string,
  out: { element: Element; group: string }[]
): void => {
  for (const child of Array.from(node.children)) {
    if (child.tagName === 'Fixture') {
      out.push({ element: child, group: groupName })
    } else if (child.tagName === 'GroupObject' || child.tagName === 'ChildList') {
      const name =
        child.tagName === 'GroupObject'
          ? child.getAttribute('name')?.trim() || groupName
          : groupName
      collectFixtures(child, name, out)
    }
  }
}

export function parseMvr(data: Uint8Array): MvrResult {
  const warnings: string[] = []

  // Skip the 3D geometry. A real export is mostly .3ds model files — one
  // 10 MB festival rig carried 218 of them against a single scene XML — and
  // inflating those costs seconds on a laptop and far worse on the phone
  // someone is actually holding. We never draw them.
  const files = unzipSync(data, {
    filter: (file) => /\.(xml|gdtf)$/i.test(file.name),
  })

  const sceneBytes = findEntry(files, (name) => name.endsWith('generalscenedescription.xml'))
  if (!sceneBytes) {
    throw new Error('Not an MVR file — no GeneralSceneDescription.xml inside.')
  }

  const scene = parseXml(decode(sceneBytes), 'GeneralSceneDescription.xml')

  // --- Fixture types, from the GDTF profiles the archive carries.
  const types = new Map<string, FixtureType>()
  const failedTypes = new Set<string>()

  const typeFor = (spec: string): FixtureType | null => {
    if (!spec) return null
    const existing = types.get(spec)
    if (existing) return existing
    if (failedTypes.has(spec)) return null

    const wanted = spec.toLowerCase()
    const bytes = findEntry(files, (name) => name === wanted || name.endsWith(`/${wanted}`))
    if (!bytes) {
      failedTypes.add(spec)
      return null
    }
    try {
      const type = typeFromGdtf(spec, bytes)
      if (type) {
        types.set(spec, type)
        return type
      }
    } catch {
      // A single unreadable profile shouldn't sink the whole rig.
    }
    failedTypes.add(spec)
    return null
  }

  // --- Fixtures, per layer.
  const found: { element: Element; group: string }[] = []
  const layers = scene.getElementsByTagName('Layer')
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i]!
    collectFixtures(layer, layer.getAttribute('name')?.trim() || `Layer ${i + 1}`, found)
  }

  const fixtures: MvrFixture[] = []
  let unaddressed = 0

  for (const { element, group } of found) {
    const spec = textOf(element, 'GDTFSpec')
    const modeName = textOf(element, 'GDTFMode')
    const type = typeFor(spec)

    const mode =
      type?.modes.find((m) => m.name === modeName) ??
      type?.modes.find((m) => m.name.toLowerCase() === modeName.toLowerCase())

    if (type && modeName && !mode) {
      warnings.push(`${type.name}: mode “${modeName}” not in its GDTF profile`)
    }

    const absolute = Number(textOf(element, 'Address'))
    const addressed = Number.isFinite(absolute) && absolute >= 1
    if (!addressed) unaddressed++
    const { universe, address } = addressed ? splitAddress(absolute) : { universe: 1, address: 0 }

    const point = parseMvrMatrix(textOf(element, 'Matrix')) ?? { x: 0, y: 0, z: 0 }

    fixtures.push({
      name: element.getAttribute('name')?.trim() ?? '',
      layer: group,
      typeId: type?.id ?? '',
      mode: mode?.name ?? modeName,
      // Without a profile the footprint is unknown; 1 is the honest default
      // and the row shows it, rather than inventing a channel count.
      footprint: mode?.footprint ?? 1,
      universe,
      address,
      // Capture writes 0 for "not assigned"; showing a channel 0 in the
      // paperwork would be worse than showing nothing.
      channel: unsetZero(textOf(element, 'FixtureID')),
      unit: unsetZero(textOf(element, 'UnitNumber')),
      x: point.x,
      y: point.y,
      z: point.z,
    })
  }

  if (failedTypes.size > 0) {
    warnings.push(
      `No GDTF profile for ${failedTypes.size} fixture type${failedTypes.size === 1 ? '' : 's'} — ` +
        `their channel counts default to 1 and need checking`
    )
  }
  if (unaddressed > 0) {
    warnings.push(`${unaddressed} fixture${unaddressed === 1 ? '' : 's'} had no DMX address`)
  }

  return { fixtures, types: [...types.values()], warnings }
}
