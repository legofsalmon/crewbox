/**
 * GDTF fixture profiles — what the manufacturer says the channels mean.
 *
 * An MVR already carries a `.gdtf` for every fixture type in the rig, and we
 * already unzip them to get the mode footprint. That file has far more in it:
 * which channel is the dimmer, which are the colour emitters, what pan and
 * tilt actually swing through in degrees, how much the thing weighs, how wide
 * it is, and what a given DMX value on the shutter channel is called.
 *
 * Reading it turns most of the live DMX view from hedging into fact. Without
 * a profile, "the highest value in this fixture's 16 channels" is the most
 * that can honestly be said; with one, it is "the dimmer is at 60%".
 *
 * Everything here is written against the published GDTF 1.2 specification
 * (mvrdevelopment/spec), not against a recollection of it, because a wrong
 * constant in a parser like this produces a fully green test suite and a
 * confidently wrong readout. Where the spec allows something this can't
 * honestly represent — a fixture patched across several DMX breaks — the
 * information is kept and the live decoder declines to use it, rather than
 * being quietly dropped or, worse, decoded at the wrong address.
 */

/** DMX ranges within a channel: `<ChannelFunction>`, in DMX order. */
export interface GdtfFunction {
  /** The function's own name — "Open", "Strobe", "Closed". */
  name: string
  /** First DMX value of the range, at the channel's own resolution. */
  from: number
  /** Physical value at `from`. Units are the attribute's. */
  physicalFrom: number
  /** Physical value at the last DMX value of the range. */
  physicalTo: number
  /**
   * Unit symbol, when this range's own attribute differs from the channel's.
   *
   * A shutter channel is `Shutter1` and unitless, but its strobe range is
   * `Shutter1Strobe` and measured in hertz. Without this the readout says
   * "Strobe 18.1" and leaves the reader to guess what of.
   */
  unit?: string
}

/** A colour-wheel position, flattened to "at this DMX value, this colour". */
export interface GdtfSlot {
  from: number
  name: string
  /** CSS colour, converted from the slot's CIE xyY. */
  colour: string
}

/** One addressable DMX channel of a mode. */
export interface GdtfChannel {
  /**
   * 1-based offsets from the fixture's start address, coarse byte first.
   * A 16-bit pan is `[1, 2]`; a virtual channel has none and isn't emitted.
   */
  offsets: number[]
  /** GDTF attribute name — "Dimmer", "Pan", "ColorAdd_R", "Shutter1". */
  attribute: string
  /** Geometry it drives. What tells cell 1 of an LED bar from cell 4. */
  geometry: string
  /**
   * Address break. crewbox patches a fixture at one address, so only break 1
   * is at a known place; the rest are carried so the readout can say the
   * fixture has channels it cannot show rather than pretend it doesn't.
   */
  dmxBreak: number
  /** Unit symbol for the physical value — "°", "%", "Hz", or empty. */
  unit: string
  /** Omitted when the ranges say nothing a percentage doesn't. */
  functions?: GdtfFunction[]
  /** Colour-wheel positions, when this channel selects one. */
  slots?: GdtfSlot[]
}

export interface GdtfMode {
  name: string
  /** Highest offset used, i.e. the DMX footprint. */
  footprint: number
  channels: GdtfChannel[]
}

export interface GdtfPhysical {
  /** Kilograms, from `<Properties><Weight Value=…>`. */
  weight?: number
  /** Watts. */
  watts?: number
  /** Metres. `width` is the widest horizontal extent — what eats bar. */
  width?: number
  height?: number
  /** Degrees, from the beam geometry. */
  beamAngle?: number
}

export interface GdtfProfile {
  manufacturer: string
  name: string
  modes: GdtfMode[]
  physical: GdtfPhysical
}

// --- Value types ------------------------------------------------------------

/**
 * `Uint/n` — a DMX value plus the byte count it was written at, which the
 * spec deliberately decouples from the channel's own resolution. Converting
 * between them is byte *mirroring* by default (so `255/1` in a 16-bit channel
 * is 65535, i.e. still full) and byte *shifting* with an `s` suffix (so
 * `255/1s` is 65280). Getting this backwards puts every range boundary of a
 * 16-bit channel 0.4% out, which is invisible until it isn't.
 *
 * Arithmetic rather than bit shifts throughout: a 4-byte channel exceeds
 * what JavaScript's bitwise operators can hold.
 */
export function parseDmxValue(text: string | null | undefined, bytes: number): number | null {
  if (!text) return null
  const match = /^\s*(\d+)\s*(?:\/\s*(\d+)\s*(s?)\s*)?$/i.exec(text)
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value)) return null
  // No "/n" at all: some exporters write a bare integer. Take it as already
  // being at the channel's resolution, which is the only reading available.
  const from = match[2] ? Number(match[2]) : bytes
  if (!Number.isFinite(from) || from < 1 || from > 4) return null
  const to = Math.max(1, Math.min(4, bytes))
  if (from === to) return value

  if (match[3]) {
    // Byte shifting: pad or truncate at the low end.
    return to > from
      ? value * Math.pow(256, to - from)
      : Math.floor(value / Math.pow(256, from - to))
  }

  // Byte mirroring: repeat the source bytes to fill the target width.
  const source: number[] = []
  for (let i = from - 1; i >= 0; i--) source.push(Math.floor(value / Math.pow(256, i)) % 256)
  let out = 0
  for (let i = 0; i < to; i++) out = out * 256 + source[i % from]!
  return out
}

/** The largest value a channel of this many bytes can carry. */
export const channelMax = (bytes: number): number => Math.pow(256, Math.max(1, bytes)) - 1

/**
 * CIE xyY → a CSS colour.
 *
 * GDTF gives wheel slots and emitters in xyY 1931. The Y is a luminance
 * relative to the fixture's own output, which is not what a schematic wants —
 * the plot dims fixtures by their intensity separately, and drawing a deep
 * congo blue at its true 4% luminance makes it black. So the hue is taken and
 * the brightness normalised away.
 */
export function xyYToCss(x: number, y: number): string {
  if (!(y > 0)) return '#ffffff'
  // Normalising Y to 1 is what drops the brightness; X and Z follow from it.
  const X = x / y
  const Z = (1 - x - y) / y
  const clamped = [
    3.2406 * X - 1.5372 - 0.4986 * Z,
    -0.9689 * X + 1.8758 + 0.0415 * Z,
    0.0557 * X - 0.204 + 1.057 * Z,
  ].map((c) => Math.max(0, c))
  const peak = Math.max(...clamped)
  const scaled = peak > 0 ? clamped.map((c) => c / peak) : [1, 1, 1]
  const gamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)
  const hex = scaled
    .map((c) =>
      Math.round(Math.max(0, Math.min(1, gamma(c))) * 255)
        .toString(16)
        .padStart(2, '0')
    )
    .join('')
  return `#${hex}`
}

/** `"0.169,0.007,10.0"` — the CIE xyY triple GDTF writes colours as. */
export const parseColorCie = (text: string | null): { x: number; y: number } | null => {
  if (!text) return null
  const parts = text.split(',').map((n) => Number(n.trim()))
  if (parts.length < 2 || parts.some((n) => !Number.isFinite(n))) return null
  return { x: parts[0]!, y: parts[1]! }
}

/** GDTF's PhysicalUnit enum → the symbol to print after a value. */
const UNIT_SYMBOLS: Record<string, string> = {
  Percent: '%',
  Length: 'm',
  Mass: 'kg',
  Time: 's',
  Temperature: 'K',
  LuminousIntensity: 'cd',
  Angle: '°',
  Force: 'N',
  Frequency: 'Hz',
  Current: 'A',
  Voltage: 'V',
  Power: 'W',
  Energy: 'J',
  Area: 'm²',
  Volume: 'm³',
  Speed: 'm/s',
  Acceleration: 'm/s²',
  AngularSpeed: '°/s',
  AngularAccc: '°/s²',
  WaveLength: 'nm',
}

/**
 * Units for the attributes a profile might not bother declaring.
 *
 * `<AttributeDefinitions>` is authoritative and read first; this covers the
 * handful that matter to the readout when a builder has left PhysicalUnit at
 * its "None" default, which is common.
 */
const FALLBACK_UNITS: Record<string, string> = {
  Pan: '°',
  Tilt: '°',
  Zoom: '°',
  Dimmer: '%',
}

// --- Element helpers --------------------------------------------------------

const attr = (element: Element, name: string): string => element.getAttribute(name)?.trim() ?? ''

const numberAttr = (element: Element, name: string): number | undefined => {
  const raw = element.getAttribute(name)
  if (raw === null || raw.trim() === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

/** Offsets of a `<DMXChannel>`, or an empty array for a virtual channel. */
const channelOffsets = (channel: Element): number[] => {
  const raw = channel.getAttribute('Offset')
  if (!raw || raw.trim().toLowerCase() === 'none') return []
  const offsets: number[] = []
  for (const part of raw.split(',')) {
    const value = Number(part.trim())
    if (Number.isFinite(value) && value >= 1) offsets.push(value)
  }
  return offsets
}

/**
 * A GDTF node link is a dot-separated path from some collect. Every use here
 * wants the leaf: `Attribute="ColorAdd_R"` and `Attribute="Color1.Color1"`
 * both mean the same attribute.
 */
const leaf = (node: string): string => {
  const parts = node.split('.')
  return parts[parts.length - 1]!.trim()
}

// --- Geometry references ----------------------------------------------------

/** Geometry node types that can appear in the `<Geometries>` tree. */
const GEOMETRY_TAGS = new Set([
  'Geometry',
  'Axis',
  'Beam',
  'FilterBeam',
  'FilterColor',
  'FilterGobo',
  'FilterShaper',
  'MediaServerLayer',
  'MediaServerCamera',
  'MediaServerMaster',
  'Display',
  'Laser',
  'WiringObject',
  'Inventory',
  'Structure',
  'Support',
  'Magnet',
])

interface GeometryReference {
  /** Break number → DMX offset (1 = no offset). */
  breaks: Map<number, number>
  /**
   * The break named by the reference's last `<Break>` child, which is the one
   * that supplies both break and offset for channels marked "Overwrite".
   */
  overwrite: { dmxBreak: number; offset: number } | null
}

interface GeometryMap {
  /** Geometry name → the name of its top-level ancestor. */
  topLevel: Map<string, string>
  /** Top-level geometry name → every place it is instantiated. */
  references: Map<string, GeometryReference[]>
  /**
   * A `<GeometryReference>` has a name of its own, and a channel is allowed
   * to address that instead of the geometry it points at — which means that
   * one channel belongs to that single instance rather than to all of them.
   */
  byName: Map<string, GeometryReference>
}

const readReference = (element: Element): GeometryReference => {
  const breaks = new Map<number, number>()
  let overwrite: GeometryReference['overwrite'] = null
  for (const child of Array.from(element.children)) {
    if (child.tagName !== 'Break') continue
    const dmxBreak = numberAttr(child, 'DMXBreak') ?? 1
    const offset = numberAttr(child, 'DMXOffset') ?? 1
    breaks.set(dmxBreak, offset)
    // The spec puts the "Overwrite" break last; every child overwrites the
    // previous, so after the loop this holds the last one.
    overwrite = { dmxBreak, offset }
  }
  return { breaks, overwrite }
}

/**
 * Walk `<Geometries>` once, recording which geometry belongs to which
 * top-level tree and which top-level trees are referenced.
 *
 * This is the part that makes an LED bar come out right. A 12-cell bar
 * defines one cell's channels and then references that cell's geometry
 * twelve times, each at its own offset — so a naive read of the channel list
 * reports a twelve-cell fixture as occupying the channels of one cell.
 */
const mapGeometries = (fixtureType: Element): GeometryMap => {
  const topLevel = new Map<string, string>()
  const references = new Map<string, GeometryReference[]>()
  const byName = new Map<string, GeometryReference>()
  const root = fixtureType.getElementsByTagName('Geometries')[0]
  if (!root) return { topLevel, references, byName }

  const walk = (element: Element, top: string): void => {
    for (const child of Array.from(element.children)) {
      if (child.tagName === 'GeometryReference') {
        const reference = readReference(child)
        const target = attr(child, 'Geometry')
        if (target) {
          const list = references.get(target) ?? []
          list.push(reference)
          references.set(target, list)
        }
        const name = attr(child, 'Name')
        if (name) byName.set(name, reference)
        continue
      }
      if (!GEOMETRY_TAGS.has(child.tagName)) continue
      const name = attr(child, 'Name')
      const ancestor = top || name
      if (name) topLevel.set(name, ancestor)
      walk(child, ancestor)
    }
  }
  walk(root, '')
  return { topLevel, references, byName }
}

// --- Wheels -----------------------------------------------------------------

/** Wheel name → its slots, 1-based as `WheelSlotIndex` expects. */
const readWheels = (fixtureType: Element): Map<string, { name: string; colour: string }[]> => {
  const wheels = new Map<string, { name: string; colour: string }[]>()
  const collect = fixtureType.getElementsByTagName('Wheels')[0]
  if (!collect) return wheels
  for (const wheel of Array.from(collect.children)) {
    if (wheel.tagName !== 'Wheel') continue
    const slots = Array.from(wheel.children)
      .filter((slot) => slot.tagName === 'Slot')
      .map((slot) => {
        const cie = parseColorCie(slot.getAttribute('Color'))
        return {
          name: attr(slot, 'Name'),
          // A slot with no Color is white by definition — which for a colour
          // wheel is the open position, so this is right rather than a guess.
          colour: cie ? xyYToCss(cie.x, cie.y) : '#ffffff',
        }
      })
    const name = attr(wheel, 'Name')
    if (name) wheels.set(name, slots)
  }
  return wheels
}

// --- Channels ---------------------------------------------------------------

/**
 * Whether a channel's function list carries anything a plain percentage
 * doesn't already say.
 *
 * The default physical range is 0→1, so a colour-mixing channel with one
 * function is exactly "0% to 100%" and its function list is dead weight in a
 * document that syncs to phones. A pan channel running −270°→270°, or a
 * shutter with eight named ranges, is not.
 */
const functionsAreInformative = (functions: GdtfFunction[]): boolean => {
  if (functions.length > 1) return true
  const only = functions[0]
  if (!only) return false
  return only.physicalFrom !== 0 || only.physicalTo !== 1 || only.unit !== undefined
}

const readFunctions = (
  logical: Element,
  bytes: number,
  wheels: Map<string, { name: string; colour: string }[]>,
  units: Map<string, string>,
  channelUnit: string
): { functions: GdtfFunction[]; slots: GdtfSlot[] } => {
  const functions: GdtfFunction[] = []
  const slots: GdtfSlot[] = []
  for (const fn of Array.from(logical.children)) {
    if (fn.tagName !== 'ChannelFunction') continue
    const from = parseDmxValue(fn.getAttribute('DMXFrom'), bytes) ?? 0
    const attribute = leaf(attr(fn, 'Attribute'))
    const unit = units.get(attribute) ?? FALLBACK_UNITS[attribute] ?? ''
    functions.push({
      name: attr(fn, 'Name') || attribute,
      from,
      physicalFrom: numberAttr(fn, 'PhysicalFrom') ?? 0,
      physicalTo: numberAttr(fn, 'PhysicalTo') ?? 1,
      ...(unit && unit !== channelUnit ? { unit } : {}),
    })

    const wheel = wheels.get(attr(fn, 'Wheel'))
    if (!wheel) continue
    for (const set of Array.from(fn.children)) {
      if (set.tagName !== 'ChannelSet') continue
      // WheelSlotIndex is "normalized to 1" — 1-based into the wheel's slots.
      const index = numberAttr(set, 'WheelSlotIndex')
      if (index === undefined || index < 1) continue
      const slot = wheel[index - 1]
      if (!slot) continue
      slots.push({
        from: parseDmxValue(set.getAttribute('DMXFrom'), bytes) ?? from,
        name: attr(set, 'Name') || slot.name,
        colour: slot.colour,
      })
    }
  }
  functions.sort((a, b) => a.from - b.from)
  slots.sort((a, b) => a.from - b.from)
  return { functions, slots }
}

const readChannels = (
  mode: Element,
  geometries: GeometryMap,
  wheels: Map<string, { name: string; colour: string }[]>,
  units: Map<string, string>
): { channels: GdtfChannel[]; footprint: number } => {
  const out: GdtfChannel[] = []
  let footprint = 0
  const channels = mode.getElementsByTagName('DMXChannel')

  for (let i = 0; i < channels.length; i++) {
    const element = channels[i]!
    const offsets = channelOffsets(element)
    // No offsets means a virtual channel, which occupies nothing.
    if (offsets.length === 0) continue

    const geometry = attr(element, 'Geometry')
    const rawBreak = element.getAttribute('DMXBreak')?.trim() ?? ''
    const overwrites = rawBreak.toLowerCase() === 'overwrite'
    const declaredBreak = overwrites ? null : Number(rawBreak || '1')
    const dmxBreak = declaredBreak !== null && Number.isFinite(declaredBreak) ? declaredBreak : 1

    // Where this channel lands, once per instance of its geometry.
    const named = geometries.byName.get(geometry)
    const instances = named
      ? [named]
      : geometries.references.get(geometries.topLevel.get(geometry) ?? geometry)
    const placed: { offsets: number[]; dmxBreak: number }[] = []
    if (!instances || instances.length === 0) {
      placed.push({ offsets, dmxBreak })
    } else {
      // A referenced geometry's channels exist once per reference. Emitting
      // only the references, never the bare channel, is what keeps a 12-cell
      // bar from being counted as one cell.
      for (const instance of instances) {
        const resolved = overwrites
          ? instance.overwrite
          : { dmxBreak, offset: instance.breaks.get(dmxBreak) ?? 1 }
        if (!resolved) continue
        const shift = resolved.offset - 1
        placed.push({
          offsets: offsets.map((offset) => offset + shift),
          dmxBreak: resolved.dmxBreak,
        })
      }
    }

    // The footprint counts every channel that takes up room, whether or not
    // this can say what it does. A profile whose channels carry no attribute
    // is unusual but still tells you how many slots the fixture eats, and
    // that number drives collision detection.
    for (const instance of placed) {
      for (const offset of instance.offsets) footprint = Math.max(footprint, offset)
    }

    const logical = Array.from(element.children).find((c) => c.tagName === 'LogicalChannel')
    // The attribute lives on the logical channel; a channel function carries
    // one too, for the ranges that change what a channel does. The logical
    // one is the channel's identity, so it wins, with the first function's as
    // a fallback for files that only fill in the latter.
    const firstFunction = logical
      ? Array.from(logical.children).find((c) => c.tagName === 'ChannelFunction')
      : undefined
    const attribute = leaf(
      (logical ? attr(logical, 'Attribute') : '') ||
        (firstFunction ? attr(firstFunction, 'Attribute') : '')
    )
    if (!attribute || attribute === 'NoFeature') continue

    const unit = units.get(attribute) ?? FALLBACK_UNITS[attribute] ?? ''
    const { functions, slots } = logical
      ? readFunctions(logical, offsets.length, wheels, units, unit)
      : { functions: [], slots: [] }

    const base = {
      attribute,
      geometry,
      unit,
      ...(functionsAreInformative(functions) ? { functions } : {}),
      ...(slots.length > 0 ? { slots } : {}),
    }
    for (const instance of placed) out.push({ ...base, ...instance })
  }
  return { channels: out, footprint }
}

// --- Physical ---------------------------------------------------------------

const readPhysical = (fixtureType: Element): GdtfPhysical => {
  const physical: GdtfPhysical = {}

  const weight = fixtureType.getElementsByTagName('Weight')[0]
  const weightValue = weight ? numberAttr(weight, 'Value') : undefined
  if (weightValue !== undefined && weightValue > 0) physical.weight = weightValue

  // Whole-fixture power, when the profile states it. A per-beam
  // PowerConsumption defaults to 1000 W in the spec, so an unset one is
  // indistinguishable from a 1 kW lamp — only an explicit attribute is read,
  // and only from the first beam, since a multi-cell fixture defines its
  // beam once and references it.
  const properties = fixtureType.getElementsByTagName('Properties')[0]
  const power = properties
    ? Array.from(properties.children).find((c) => c.tagName === 'PowerConsumption')
    : undefined
  const declared = power ? numberAttr(power, 'Value') : undefined
  if (declared !== undefined && declared > 0) physical.watts = declared

  const beam = fixtureType.getElementsByTagName('Beam')[0]
  if (beam) {
    if (physical.watts === undefined) {
      const beamPower = numberAttr(beam, 'PowerConsumption')
      if (beamPower !== undefined && beamPower > 0) physical.watts = beamPower
    }
    const angle = numberAttr(beam, 'BeamAngle')
    if (angle !== undefined && angle > 0) physical.beamAngle = angle
  }

  /*
   * Dimensions come from `<Models>`: one model per part — base, yoke, head —
   * each with Length (X), Width (Y) and Height (Z) in metres.
   *
   * What the truss estimator wants is how much bar a fixture eats, and a
   * fixture can hang in any orientation, so the widest horizontal extent of
   * the largest part is the useful number. Taking the maximum across parts
   * overstates a fixture whose base and head are widest on different axes,
   * which is the same safe direction `truss.ts` already errs in: too much
   * truss is an annoyance, too little is a redesign on the day.
   */
  let width = 0
  let height = 0
  const models = fixtureType.getElementsByTagName('Model')
  for (let i = 0; i < models.length; i++) {
    const model = models[i]!
    width = Math.max(width, numberAttr(model, 'Length') ?? 0, numberAttr(model, 'Width') ?? 0)
    height = Math.max(height, numberAttr(model, 'Height') ?? 0)
  }
  if (width > 0) physical.width = width
  if (height > 0) physical.height = height

  return physical
}

// --- Entry point ------------------------------------------------------------

/** Attribute name → unit symbol, from `<AttributeDefinitions>`. */
const readUnits = (fixtureType: Element): Map<string, string> => {
  const units = new Map<string, string>()
  const definitions = fixtureType.getElementsByTagName('AttributeDefinitions')[0]
  if (!definitions) return units
  const attributes = definitions.getElementsByTagName('Attribute')
  for (let i = 0; i < attributes.length; i++) {
    const element = attributes[i]!
    const name = attr(element, 'Name')
    const symbol = UNIT_SYMBOLS[attr(element, 'PhysicalUnit')]
    if (name && symbol) units.set(name, symbol)
  }
  return units
}

/**
 * Read a parsed `description.xml` into a profile.
 *
 * Returns null only when the document isn't a GDTF at all. A profile with no
 * usable modes is still returned, so a caller can say "this file has no DMX
 * modes" rather than "this file is broken".
 */
export function parseGdtfProfile(doc: Document): GdtfProfile | null {
  const fixtureType = doc.getElementsByTagName('FixtureType')[0]
  if (!fixtureType) return null

  const geometries = mapGeometries(fixtureType)
  const wheels = readWheels(fixtureType)
  const units = readUnits(fixtureType)

  const modes: GdtfMode[] = []
  const modeElements = fixtureType.getElementsByTagName('DMXMode')
  for (let i = 0; i < modeElements.length; i++) {
    const element = modeElements[i]!
    const { channels, footprint } = readChannels(element, geometries, wheels, units)
    if (footprint === 0) continue
    modes.push({
      name: attr(element, 'Name') || `Mode ${i + 1}`,
      footprint,
      channels,
    })
  }

  return {
    manufacturer: attr(fixtureType, 'Manufacturer'),
    name: attr(fixtureType, 'Name'),
    modes,
    physical: readPhysical(fixtureType),
  }
}
