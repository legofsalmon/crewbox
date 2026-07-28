import { findFixtureType, findMode } from './fixtures'
import { channelMax, type GdtfChannel, type GdtfFunction, type GdtfSlot } from './gdtf'
import type { Fixture, FixtureType } from './types'

/**
 * The live DMX view, read through the fixture's own GDTF profile.
 *
 * `live.ts` is what can be said with no profile at all: the highest value in
 * a fixture's footprint, which is honest but blunt — a moving head panning
 * hard in the dark reads as full. With a profile, the same slots answer real
 * questions: the dimmer is at 60%, the colour wheel is on congo, pan is at
 * −135°.
 *
 * Everything here degrades rather than guesses. A profile with no dimmer
 * channel falls back to the peak and says that is what it did; a fixture
 * whose colour comes from a wheel this can't resolve gets no colour rather
 * than an invented one.
 */

/** Attributes that mean "how bright", in the order they'd be believed. */
const INTENSITY_ATTRIBUTES = ['Dimmer']

/**
 * The emitters GDTF names, as sRGB.
 *
 * A profile can link each colour channel to an `<Emitter>` carrying the
 * emitter's measured spectrum, which would be better — but most files in
 * circulation don't, and the attribute names are themselves normative: the
 * specification defines ColorAdd_RY as amber and ColorAdd_GY as lime. These
 * are those definitions, at full saturation, for tinting a dot on a plan.
 */
const EMITTERS: Record<string, [number, number, number]> = {
  ColorAdd_R: [1, 0, 0],
  ColorAdd_G: [0, 1, 0],
  ColorAdd_B: [0, 0, 1],
  ColorAdd_C: [0, 1, 1],
  ColorAdd_M: [1, 0, 1],
  ColorAdd_Y: [1, 1, 0],
  ColorAdd_RY: [1, 0.65, 0], // amber
  ColorAdd_GY: [0.75, 1, 0], // lime
  ColorAdd_GC: [0, 1, 0.6], // blue-green
  ColorAdd_BC: [0.3, 0.75, 1], // light blue
  ColorAdd_BM: [0.55, 0.2, 1], // purple
  ColorAdd_RM: [1, 0.35, 0.65], // pink
  ColorAdd_W: [1, 1, 1],
  ColorAdd_WW: [1, 0.85, 0.65], // warm white
  ColorAdd_CW: [0.85, 0.93, 1], // cool white
  ColorAdd_UV: [0.45, 0.15, 1],
}

/** Subtractive flags, and which channel of white each one takes out. */
const SUBTRACTIVE: Record<string, 0 | 1 | 2> = {
  ColorSub_C: 0,
  ColorSub_R: 0,
  ColorSub_M: 1,
  ColorSub_G: 1,
  ColorSub_Y: 2,
  ColorSub_B: 2,
}

/**
 * The channel map for the mode a fixture is patched in, or null.
 *
 * Null is the ordinary case, not an error: a hand-typed fixture, a CSV
 * import, or a mode nobody in this rig uses all land here, and every caller
 * below has an answer for it.
 */
export function fixtureChannels(
  fixture: Pick<Fixture, 'typeId' | 'mode'>,
  customTypes: FixtureType[]
): GdtfChannel[] | null {
  const type = findFixtureType(fixture.typeId, customTypes)
  if (!type) return null
  const mode = findMode(type, fixture.mode) ?? (type.modes.length === 1 ? type.modes[0] : undefined)
  const channels = mode?.channels
  return channels && channels.length > 0 ? channels : null
}

/**
 * Absolute DMX addresses a channel occupies, coarse byte first.
 *
 * Only break 1 counts. A fixture patched across several breaks has a
 * separate start address per break, which crewbox's one-address-per-fixture
 * model has nowhere to put — so those channels are reported as unplaceable
 * rather than read from the wrong slots.
 */
export function channelAddresses(channel: GdtfChannel, startAddress: number): number[] | null {
  if (channel.dmxBreak !== 1 || startAddress < 1) return null
  const addresses = channel.offsets.map((offset) => startAddress + offset - 1)
  return addresses.every((address) => address >= 1 && address <= 512) ? addresses : null
}

/** A channel's value, combined MSB-first, or null when it isn't readable. */
export function readChannel(
  channel: GdtfChannel,
  startAddress: number,
  slots: Uint8Array
): number | null {
  const addresses = channelAddresses(channel, startAddress)
  if (!addresses) return null
  let value = 0
  for (const address of addresses) {
    const byte = slots[address - 1]
    if (byte === undefined) return null
    value = value * 256 + byte
  }
  return value
}

/**
 * The channel function a raw value falls in, and the physical value there.
 *
 * A function's range runs to the next function's start minus one, or to the
 * top of the channel — the specification defines the end that way rather
 * than storing it, so it has to be worked out from the neighbour.
 */
export function decodeChannel(
  channel: GdtfChannel,
  raw: number
): { fn: GdtfFunction | null; physical: number | null } {
  const max = channelMax(channel.offsets.length)
  const functions = channel.functions
  if (!functions || functions.length === 0) {
    // No stored ranges means the channel was a plain 0→1 proportion; see
    // `functionsAreInformative` in gdtf.ts.
    return { fn: null, physical: max > 0 ? raw / max : null }
  }

  let index = 0
  for (let i = 0; i < functions.length; i++) {
    if (raw >= functions[i]!.from) index = i
  }
  const fn = functions[index]!
  const next = functions[index + 1]
  const to = next ? next.from - 1 : max
  const span = to - fn.from
  const physical =
    span > 0
      ? fn.physicalFrom + ((raw - fn.from) / span) * (fn.physicalTo - fn.physicalFrom)
      : fn.physicalFrom
  return { fn, physical }
}

/** The wheel position a raw value selects, when this channel is a wheel. */
export function decodeSlot(channel: GdtfChannel, raw: number): GdtfSlot | null {
  if (!channel.slots || channel.slots.length === 0) return null
  let found: GdtfSlot | null = null
  for (const slot of channel.slots) {
    if (raw >= slot.from) found = slot
  }
  return found
}

// --- Intensity --------------------------------------------------------------

export interface FixtureIntensity {
  /** 0–1. */
  level: number
  /**
   * `dimmer` means a real intensity channel was read. `peak` means the
   * profile has none — an LED with no master dimmer, or no profile at all —
   * and this is the highest value anywhere in the footprint, which is not
   * the same claim.
   */
  basis: 'dimmer' | 'peak'
}

/**
 * How bright a fixture is being told to be.
 *
 * The multi-cell case takes the brightest cell: a bar with one pixel up is
 * a bar that is on, and drawing it dark would be the wrong answer to the
 * question the plot is being asked.
 */
export function fixtureIntensity(
  fixture: Pick<Fixture, 'typeId' | 'mode' | 'universe' | 'address' | 'footprint'>,
  customTypes: FixtureType[],
  levels: Map<number, Uint8Array>
): FixtureIntensity | null {
  const slots = levels.get(fixture.universe)
  if (!slots || fixture.address < 1) return null

  const channels = fixtureChannels(fixture, customTypes)
  const dimmers = channels?.filter((channel) => INTENSITY_ATTRIBUTES.includes(channel.attribute))

  if (dimmers && dimmers.length > 0) {
    let best: number | null = null
    for (const channel of dimmers) {
      const raw = readChannel(channel, fixture.address, slots)
      if (raw === null) continue
      const max = channelMax(channel.offsets.length)
      if (max > 0) best = Math.max(best ?? 0, raw / max)
    }
    if (best !== null) return { level: best, basis: 'dimmer' }
  }

  const from = fixture.address - 1
  const to = Math.min(from + Math.max(1, fixture.footprint), slots.length)
  let peak = 0
  for (let i = from; i < to; i++) peak = Math.max(peak, slots[i]!)
  return { level: peak / 255, basis: 'peak' }
}

/**
 * The addresses that decide whether a fixture has ever been lit.
 *
 * With a dimmer channel this is those slots alone, which is a much sharper
 * question than "has anything in these sixteen channels ever moved": a head
 * parked at a position with its shutter shut has a non-zero pan channel
 * forever, and would otherwise read as live from the moment the desk booted.
 *
 * Null means "no profile" — judge the whole footprint, as before.
 */
export function intensityAddresses(
  fixture: Pick<Fixture, 'typeId' | 'mode' | 'address'>,
  customTypes: FixtureType[]
): number[] | null {
  const channels = fixtureChannels(fixture, customTypes)
  if (!channels) return null
  const addresses: number[] = []
  for (const channel of channels) {
    if (!INTENSITY_ATTRIBUTES.includes(channel.attribute)) continue
    const placed = channelAddresses(channel, fixture.address)
    if (placed) addresses.push(...placed)
  }
  return addresses.length > 0 ? addresses : null
}

// --- Colour -----------------------------------------------------------------

export interface FixtureColour {
  /** CSS hex. */
  css: string
  /** Which mechanisms produced it, in the order they were applied. */
  from: ('additive' | 'subtractive' | 'wheel')[]
}

const hex = (rgb: [number, number, number]): string =>
  `#${rgb
    .map((c) =>
      Math.round(Math.max(0, Math.min(1, c)) * 255)
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`

const parseHex = (css: string): [number, number, number] | null => {
  const match = /^#([0-9a-f]{6})$/i.exec(css)
  if (!match) return null
  const value = parseInt(match[1]!, 16)
  return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255]
}

/**
 * What colour a fixture is being asked for, or null when nothing says.
 *
 * Emitters add, filter flags subtract, and a wheel slot multiplies over
 * whatever came out of the two — which is the order light actually meets
 * them in a fixture that has all three.
 *
 * The result is normalised to full brightness on purpose: the plot shows
 * intensity by dimming the fixture separately, so a deep blue at 5% of its
 * output should still be drawn blue rather than black.
 */
export function fixtureColour(
  fixture: Pick<Fixture, 'typeId' | 'mode' | 'universe' | 'address'>,
  customTypes: FixtureType[],
  levels: Map<number, Uint8Array>
): FixtureColour | null {
  const slots = levels.get(fixture.universe)
  const channels = fixtureChannels(fixture, customTypes)
  if (!slots || !channels || fixture.address < 1) return null

  const from: FixtureColour['from'] = []
  let rgb: [number, number, number] | null = null

  // Additive: sum the emitters that are up.
  let added: [number, number, number] = [0, 0, 0]
  let anyEmitter = false
  for (const channel of channels) {
    const emitter = EMITTERS[channel.attribute]
    if (!emitter) continue
    const raw = readChannel(channel, fixture.address, slots)
    if (raw === null) continue
    anyEmitter = true
    const level = raw / channelMax(channel.offsets.length)
    added = [
      added[0] + emitter[0] * level,
      added[1] + emitter[1] * level,
      added[2] + emitter[2] * level,
    ]
  }
  if (anyEmitter) {
    const peak = Math.max(...added)
    // Every emitter at zero is a dark fixture, not a black one: leave the
    // colour unstated rather than painting it.
    if (peak > 0) {
      rgb = [added[0] / peak, added[1] / peak, added[2] / peak]
      from.push('additive')
    }
  }

  // Subtractive: CMY flags take their channel out of what's there.
  let filtered = rgb ?? [1, 1, 1]
  let anyFilter = false
  for (const channel of channels) {
    const index = SUBTRACTIVE[channel.attribute]
    if (index === undefined) continue
    const raw = readChannel(channel, fixture.address, slots)
    if (raw === null) continue
    const level = raw / channelMax(channel.offsets.length)
    if (level > 0) anyFilter = true
    filtered = [...filtered] as [number, number, number]
    filtered[index] *= 1 - level
  }
  if (anyFilter) {
    rgb = filtered
    from.push('subtractive')
  }

  // A wheel slot filters whatever reached it.
  for (const channel of channels) {
    if (!channel.slots) continue
    const raw = readChannel(channel, fixture.address, slots)
    if (raw === null) continue
    const slot = decodeSlot(channel, raw)
    const wheel = slot ? parseHex(slot.colour) : null
    if (!wheel) continue
    const base = rgb ?? [1, 1, 1]
    rgb = [base[0] * wheel[0], base[1] * wheel[1], base[2] * wheel[2]]
    from.push('wheel')
  }

  if (!rgb || from.length === 0) return null
  const peak = Math.max(...rgb)
  // A closed CMY or a black-out slot is a fixture asking for no light. That
  // is intensity, not colour, and the plot already draws it.
  if (peak <= 0) return null
  return { css: hex([rgb[0] / peak, rgb[1] / peak, rgb[2] / peak]), from }
}

// --- Position ---------------------------------------------------------------

export interface FixtureOrientation {
  /** Degrees, as the profile defines them. Null when the mode has none. */
  pan: number | null
  tilt: number | null
}

/** Where a moving head is pointed, in the profile's own degrees. */
export function fixtureOrientation(
  fixture: Pick<Fixture, 'typeId' | 'mode' | 'universe' | 'address'>,
  customTypes: FixtureType[],
  levels: Map<number, Uint8Array>
): FixtureOrientation | null {
  const slots = levels.get(fixture.universe)
  const channels = fixtureChannels(fixture, customTypes)
  if (!slots || !channels || fixture.address < 1) return null

  const degrees = (attribute: string): number | null => {
    const channel = channels.find((c) => c.attribute === attribute)
    if (!channel) return null
    const raw = readChannel(channel, fixture.address, slots)
    if (raw === null) return null
    const { fn, physical } = decodeChannel(channel, raw)
    if (physical === null) return null
    // A profile that leaves the physical range at its 0→1 default says
    // nothing about degrees; spread it over a full turn rather than
    // reporting a head pointed 0.7° off centre.
    const stated = fn && (fn.physicalFrom !== 0 || fn.physicalTo !== 1)
    return stated ? physical : physical * 360 - 180
  }

  const pan = degrees('Pan')
  const tilt = degrees('Tilt')
  return pan === null && tilt === null ? null : { pan, tilt }
}

// --- Readout ----------------------------------------------------------------

export interface ChannelReading {
  /** GDTF attribute name — the label. */
  attribute: string
  /** Geometry, so a multi-cell fixture's four dimmers are tellable apart. */
  geometry: string
  /** Absolute addresses, or null for a channel on another break. */
  addresses: number[] | null
  /** Raw value at the channel's own resolution. */
  raw: number | null
  /** The named range the value is in, when it differs from the attribute. */
  state: string
  /** Formatted physical value — "60%", "−135.0°", "8.4 Hz". */
  value: string
  /** The wheel slot's colour, for a swatch. */
  colour: string | null
}

const round = (value: number): string => {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

/**
 * Format a decoded channel value.
 *
 * A percentage is the right answer more often than it looks: GDTF's default
 * physical range is 0→1, so every colour-mixing channel and most dimmers are
 * proportions, and printing "0.6" for one would be worse than useless.
 *
 * The empty string is a real answer here. A shutter's ranges are named
 * states — Closed, Open, Strobe — and a builder who names them usually
 * leaves the physical range at its default, so the number derived from it
 * means nothing. The name is the value; the readout still shows the raw DMX
 * beside it.
 */
const formatValue = (
  channel: GdtfChannel,
  fn: GdtfFunction | null,
  physical: number | null,
  named: boolean
): string => {
  if (physical === null) return ''
  // A range can carry its own unit: a shutter channel is unitless, but its
  // strobe range is in hertz.
  const unit = fn?.unit ?? channel.unit
  const defaultRange = !fn || (fn.physicalFrom === 0 && fn.physicalTo === 1)
  if (named && defaultRange && unit !== '%') return ''
  if (unit === '%' || (unit === '' && defaultRange)) return `${Math.round(physical * 100)}%`
  if (unit === '') return round(physical)
  return `${round(physical)}${unit === '°' ? '' : ' '}${unit}`
}

/**
 * Every channel of a fixture, decoded — the answer to "what is the desk
 * actually sending it", which is the question someone asks with a torch in
 * their teeth halfway up a ladder.
 */
export function channelReadout(
  fixture: Pick<Fixture, 'typeId' | 'mode' | 'universe' | 'address'>,
  customTypes: FixtureType[],
  levels: Map<number, Uint8Array>
): ChannelReading[] {
  const channels = fixtureChannels(fixture, customTypes)
  if (!channels) return []
  const slots = levels.get(fixture.universe)

  return channels
    .map((channel): ChannelReading => {
      const addresses = channelAddresses(channel, fixture.address)
      const raw = slots ? readChannel(channel, fixture.address, slots) : null
      if (raw === null) {
        return {
          attribute: channel.attribute,
          geometry: channel.geometry,
          addresses,
          raw: null,
          state: '',
          value: '',
          colour: null,
        }
      }
      const { fn, physical } = decodeChannel(channel, raw)
      const slot = decodeSlot(channel, raw)
      const name = slot?.name || fn?.name || ''
      const state = name && name !== channel.attribute ? name : ''
      return {
        attribute: channel.attribute,
        geometry: channel.geometry,
        addresses,
        raw,
        state,
        // A wheel position is the whole answer; the number behind it is the
        // slot boundary, not a level.
        value: slot ? '' : formatValue(channel, fn, physical, state !== ''),
        colour: slot?.colour ?? null,
      }
    })
    .sort((a, b) => (a.addresses?.[0] ?? 999) - (b.addresses?.[0] ?? 999))
}
