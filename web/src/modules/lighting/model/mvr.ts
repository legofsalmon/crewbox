import { unzipSync } from 'fflate'
import { parseGdtfProfile } from './gdtf'
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
  /** The scene object's own uuid — what makes a re-import an update. */
  uuid: string
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
 * The largest entry worth inflating.
 *
 * Generous — a big rig's scene description runs to a few megabytes, and a
 * GDTF profile with its models can be tens — so the only thing this refuses
 * is an entry whose declared size is not a real file's. A zip's header is
 * whatever wrote it, and a crew member opening a file somebody emailed them
 * should not be able to be handed a gigabyte to inflate on a phone.
 */
const MAX_ENTRY_BYTES = 256 * 1024 * 1024

/** An unzip filter: this name, and a size that could be a real file. */
const wantedEntry =
  (name: RegExp) =>
  (file: { name: string; originalSize: number }): boolean =>
    name.test(file.name) && file.originalSize <= MAX_ENTRY_BYTES

/**
 * Build a crewbox fixture type from an embedded .gdtf archive.
 *
 * The channel maps come back attached to every mode; `parseMvr` strips them
 * from the modes nobody in this rig is patched in, because a type with ten
 * modes would otherwise put nine modes' worth of channel definitions into a
 * document that syncs to every phone on site.
 */
const typeFromGdtf = (id: string, gdtfBytes: Uint8Array): FixtureType | null => {
  // The one file in here that is wanted.
  //
  // The outer archive is filtered for exactly this reason and the inner one
  // was not, so every embedded profile's 3D models, gobo wheel images and
  // thumbnails were inflated in full to reach one XML — several megabytes
  // per fixture type, on the phone somebody is holding at the top of a
  // ladder. Nothing draws any of it.
  const inner = unzipSync(gdtfBytes, { filter: wantedEntry(/description\.xml$/i) })
  const descriptionBytes = findEntry(inner, (name) => name.endsWith('description.xml'))
  if (!descriptionBytes) return null

  const profile = parseGdtfProfile(parseXml(decode(descriptionBytes), 'GDTF description'))
  if (!profile || profile.modes.length === 0) return null

  const { manufacturer } = profile
  const name = profile.name || id

  const modes: FixtureMode[] = profile.modes.map((mode) => ({
    name: mode.name,
    footprint: mode.footprint,
    ...(mode.channels.length > 0 ? { channels: mode.channels } : {}),
  }))

  return {
    id,
    name: manufacturer && !name.startsWith(manufacturer) ? `${manufacturer} ${name}` : name,
    modes,
    ...(profile.physical.watts !== undefined ? { watts: profile.physical.watts } : {}),
    ...(profile.physical.weight !== undefined ? { weight: profile.physical.weight } : {}),
    ...(profile.physical.width !== undefined ? { width: profile.physical.width } : {}),
    ...(profile.physical.height !== undefined ? { height: profile.physical.height } : {}),
    ...(profile.physical.beamAngle !== undefined ? { beamAngle: profile.physical.beamAngle } : {}),
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
 * What an `<Address>` says, in the two ways exporters write it.
 *
 * The spec's own form is one absolute number counting from universe 1
 * channel 1, so 513 is universe 2 channel 1. But plenty of exporters write
 * the desk's notation instead — `2.001`, or `2.1`, meaning universe 2,
 * address 1 — and that used to go through `Number()` into `splitAddress`
 * unremarked: `2.001` became universe 1, address 2.001. A fractional
 * address is not a number the rest of the module has any idea what to do
 * with, so the fixture landed a channel out, overlap detection compared it
 * against nothing, and the rig sheet read as clean.
 *
 * The digits after the point are the address as written — `.001` is 1 and
 * `.257` is 257 — which is how a desk prints them and how the person who
 * exported the file reads them back.
 */
export const parseMvrAddress = (text: string): { universe: number; address: number } | null => {
  const trimmed = text.trim()
  const dotted = /^(\d+)\.(\d+)$/.exec(trimmed)
  if (dotted) {
    const universe = Number(dotted[1])
    const address = Number(dotted[2])
    if (universe < 1 || address < 1 || address > DMX_UNIVERSE_SIZE) return null
    return { universe, address }
  }
  if (!/^\d+$/.test(trimmed)) return null
  const absolute = Number(trimmed)
  if (absolute < 1) return null
  return splitAddress(absolute)
}

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
  const files = unzipSync(data, { filter: wantedEntry(/\.(xml|gdtf)$/i) })

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

    const patched = parseMvrAddress(textOf(element, 'Address'))
    if (!patched) unaddressed++
    const { universe, address } = patched ?? { universe: 1, address: 0 }

    const point = parseMvrMatrix(textOf(element, 'Matrix')) ?? { x: 0, y: 0, z: 0 }

    fixtures.push({
      uuid: element.getAttribute('uuid')?.trim() ?? '',
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

  /*
   * Channel maps go into the plot document, which syncs to every phone on
   * site, so only the modes this rig is actually patched in keep theirs. A
   * moving head's profile carries eight modes and nobody is in seven of
   * them; the names and footprints stay so the mode picker still works.
   */
  const modesInUse = new Map<string, Set<string>>()
  for (const fixture of fixtures) {
    if (!fixture.typeId) continue
    const names = modesInUse.get(fixture.typeId) ?? new Set<string>()
    names.add(fixture.mode)
    modesInUse.set(fixture.typeId, names)
  }

  const trimmed = [...types.values()].map((type) => ({
    ...type,
    modes: type.modes.map((mode) =>
      modesInUse.get(type.id)?.has(mode.name)
        ? mode
        : { name: mode.name, footprint: mode.footprint }
    ),
  }))

  return { fixtures, types: trimmed, warnings }
}
