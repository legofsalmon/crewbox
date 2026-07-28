// @vitest-environment happy-dom
//
// GDTF profiles are read with DOMParser, same as MVR — see mvr.test.ts.
import { describe, expect, it } from 'vitest'
// Imported as text rather than read off disk: happy-dom rewrites
// `import.meta.url` to an http URL, so the usual file-relative read can't
// find it.
import realProfileXml from './__fixtures__/led-par-64-rgbw.description.xml?raw'
import { channelMax, parseDmxValue, parseGdtfProfile, xyYToCss } from './gdtf'

/**
 * These build real `description.xml` documents rather than stubbing the
 * decode, because the parts most likely to be wrong are structural: which
 * element carries the attribute, how a geometry reference multiplies a
 * channel, how a DMX value written at one byte count lands in a channel of
 * another.
 *
 * The byte-conversion cases are taken from the worked examples in the GDTF
 * specification itself, so they check the parser against the standard rather
 * than against my own reading of it.
 */

const parse = (xml: string) => {
  const doc = new DOMParser().parseFromString(
    `<?xml version="1.0" encoding="UTF-8"?><GDTF DataVersion="1.2">${xml}</GDTF>`,
    'application/xml'
  )
  return parseGdtfProfile(doc)
}

/** A fixture type wrapping some modes, with no geometry tree. */
const simple = (channels: string, extra = '') =>
  parse(
    `<FixtureType Name="Sharpy" Manufacturer="Clay Paky">${extra}` +
      `<DMXModes><DMXMode Name="Standard">` +
      `<DMXChannels>${channels}</DMXChannels>` +
      `</DMXMode></DMXModes></FixtureType>`
  )

/** `<DMXChannel>` with one logical channel carrying `attribute`. */
const channel = (offset: string, attribute: string, geometry = 'Head', inner = '') =>
  `<DMXChannel DMXBreak="1" Offset="${offset}" Geometry="${geometry}">` +
  `<LogicalChannel Attribute="${attribute}">${inner || `<ChannelFunction Name="${attribute}" Attribute="${attribute}" DMXFrom="0/1"/>`}</LogicalChannel>` +
  `</DMXChannel>`

describe('DMX values written at one byte count, read at another', () => {
  it('leaves a value alone when the widths already match', () => {
    expect(parseDmxValue('128/1', 1)).toBe(128)
    expect(parseDmxValue('40000/2', 2)).toBe(40000)
  })

  it('mirrors bytes by default, so full stays full', () => {
    // The specification's own example: "255/1 in a 16 bit channel will
    // result in 65535". Shifting would give 65280 — a fixture at 99.6%,
    // which is the sort of error that never looks like an error.
    expect(parseDmxValue('255/1', 2)).toBe(65535)
    expect(parseDmxValue('255/1', 3)).toBe(0xffffff)
    expect(parseDmxValue('0/1', 2)).toBe(0)
    expect(parseDmxValue('128/1', 2)).toBe(128 * 256 + 128)
  })

  it('shifts bytes when asked, and only then', () => {
    // The specification's second example: "255/1s in a 16 bit channel will
    // result in 65280".
    expect(parseDmxValue('255/1s', 2)).toBe(65280)
    expect(parseDmxValue('1/1s', 2)).toBe(256)
  })

  it('narrows to the high bytes', () => {
    expect(parseDmxValue('65535/2', 1)).toBe(255)
    expect(parseDmxValue('256/2', 1)).toBe(1)
    expect(parseDmxValue('65535/2s', 1)).toBe(255)
  })

  it('takes a bare integer as already being at the channel resolution', () => {
    // Not in the spec, but exporters write it and refusing to read the file
    // over a missing "/1" would be a poor trade.
    expect(parseDmxValue('200', 1)).toBe(200)
    expect(parseDmxValue('200', 2)).toBe(200)
  })

  it('returns null rather than a plausible number for nonsense', () => {
    expect(parseDmxValue('', 1)).toBeNull()
    expect(parseDmxValue(null, 1)).toBeNull()
    expect(parseDmxValue('open', 1)).toBeNull()
    expect(parseDmxValue('255/', 1)).toBeNull()
  })

  it('knows how big a channel can get', () => {
    expect(channelMax(1)).toBe(255)
    expect(channelMax(2)).toBe(65535)
  })
})

describe('CIE xyY to something drawable', () => {
  it('turns the D65 white point into white', () => {
    expect(xyYToCss(0.3127, 0.329)).toBe('#ffffff')
  })

  it('turns the sRGB primaries into their primaries', () => {
    expect(xyYToCss(0.64, 0.33).slice(0, 3)).toBe('#ff')
    expect(xyYToCss(0.3, 0.6).slice(3, 5)).toBe('ff')
    expect(xyYToCss(0.15, 0.06).slice(5, 7)).toBe('ff')
  })

  it('keeps a deep colour visible instead of drawing it black', () => {
    // A congo blue slot has a real luminance of a few percent. The plot
    // shows intensity by dimming the fixture, so the slot contributes hue
    // only — otherwise every saturated colour reads as "off".
    const congo = xyYToCss(0.16, 0.05)
    expect(congo).not.toBe('#000000')
    expect(congo.slice(5, 7)).toBe('ff')
  })

  it('falls back to white rather than dividing by zero', () => {
    expect(xyYToCss(0.3, 0)).toBe('#ffffff')
  })
})

describe('reading a mode', () => {
  it('takes the attribute from the logical channel', () => {
    const profile = simple(channel('1', 'Dimmer'))
    expect(profile!.modes[0]!.channels).toEqual([
      expect.objectContaining({ attribute: 'Dimmer', offsets: [1], geometry: 'Head' }),
    ])
  })

  it('falls back to the channel function when the logical channel is bare', () => {
    // Both elements carry an Attribute in the spec. Builders that fill in
    // only the function are common enough to be worth reading.
    const profile = simple(
      `<DMXChannel DMXBreak="1" Offset="1" Geometry="Head"><LogicalChannel>` +
        `<ChannelFunction Attribute="Dimmer" DMXFrom="0/1"/></LogicalChannel></DMXChannel>`
    )
    expect(profile!.modes[0]!.channels[0]!.attribute).toBe('Dimmer')
  })

  it('takes the leaf of a dotted attribute path', () => {
    const profile = simple(channel('1', 'Color1.Color1'))
    expect(profile!.modes[0]!.channels[0]!.attribute).toBe('Color1')
  })

  it('keeps both bytes of a 16-bit channel, coarse first', () => {
    const profile = simple(channel('1,2', 'Pan'))
    expect(profile!.modes[0]!.channels[0]!.offsets).toEqual([1, 2])
    expect(profile!.modes[0]!.footprint).toBe(2)
  })

  it('drops virtual channels without shrinking the footprint', () => {
    const profile = simple(channel('None', 'Control') + channel('4', 'Dimmer'))
    expect(profile!.modes[0]!.channels).toHaveLength(1)
    expect(profile!.modes[0]!.footprint).toBe(4)
  })

  it('ignores a channel that does nothing', () => {
    const profile = simple(channel('1', 'NoFeature') + channel('2', 'Dimmer'))
    expect(profile!.modes[0]!.channels.map((c) => c.attribute)).toEqual(['Dimmer'])
  })

  it('carries a channel on another break without pretending to place it', () => {
    // crewbox patches a fixture at one address, so a break-2 channel is not
    // at a knowable slot. Keeping it lets the readout say so.
    const profile = simple(
      channel('1', 'Dimmer') +
        `<DMXChannel DMXBreak="2" Offset="1" Geometry="Head"><LogicalChannel Attribute="Zoom">` +
        `<ChannelFunction DMXFrom="0/1"/></LogicalChannel></DMXChannel>`
    )
    expect(profile!.modes[0]!.channels.map((c) => c.dmxBreak)).toEqual([1, 2])
  })
})

describe('what a channel is worth storing about', () => {
  it('keeps ranges that say something a percentage does not', () => {
    const profile = simple(
      channel(
        '1,2',
        'Pan',
        'Yoke',
        `<ChannelFunction Name="Pan" Attribute="Pan" DMXFrom="0/1" PhysicalFrom="-270" PhysicalTo="270"/>`
      )
    )
    expect(profile!.modes[0]!.channels[0]!.functions).toEqual([
      { name: 'Pan', from: 0, physicalFrom: -270, physicalTo: 270 },
    ])
  })

  it('drops ranges that are just "nought to full"', () => {
    // A colour-mixing channel with one 0→1 function says exactly what a
    // percentage says. Every byte of this document syncs to a phone.
    const profile = simple(channel('1', 'ColorAdd_R'))
    expect(profile!.modes[0]!.channels[0]!.functions).toBeUndefined()
  })

  it('keeps several ranges, in DMX order, however they were written', () => {
    const profile = simple(
      channel(
        '1',
        'Shutter1',
        'Head',
        `<ChannelFunction Name="Strobe" Attribute="Shutter1Strobe" DMXFrom="64/1" PhysicalFrom="1" PhysicalTo="20"/>` +
          `<ChannelFunction Name="Closed" Attribute="Shutter1" DMXFrom="0/1"/>` +
          `<ChannelFunction Name="Open" Attribute="Shutter1" DMXFrom="32/1"/>`
      )
    )
    expect(profile!.modes[0]!.channels[0]!.functions!.map((f) => [f.name, f.from])).toEqual([
      ['Closed', 0],
      ['Open', 32],
      ['Strobe', 64],
    ])
  })

  it('names a function after its attribute when it has no name', () => {
    const profile = simple(
      channel(
        '1',
        'Shutter1',
        'Head',
        `<ChannelFunction Attribute="Shutter1" DMXFrom="0/1"/>` +
          `<ChannelFunction Attribute="Shutter1Strobe" DMXFrom="64/1"/>`
      )
    )
    expect(profile!.modes[0]!.channels[0]!.functions!.map((f) => f.name)).toEqual([
      'Shutter1',
      'Shutter1Strobe',
    ])
  })
})

describe('colour wheels', () => {
  const wheels =
    `<Wheels><Wheel Name="ColorWheel">` +
    `<Slot Name="Open"/>` +
    `<Slot Name="Red" Color="0.64,0.33,20"/>` +
    `<Slot Name="Blue" Color="0.15,0.06,5"/>` +
    `</Wheel></Wheels>`

  it('flattens wheel, function and channel set into DMX value to colour', () => {
    const profile = simple(
      channel(
        '1',
        'Color1',
        'Head',
        `<ChannelFunction Name="Colour" Attribute="Color1" DMXFrom="0/1" Wheel="ColorWheel">` +
          `<ChannelSet Name="Open" DMXFrom="0/1" WheelSlotIndex="1"/>` +
          `<ChannelSet Name="Red" DMXFrom="10/1" WheelSlotIndex="2"/>` +
          `<ChannelSet Name="Blue" DMXFrom="20/1" WheelSlotIndex="3"/>` +
          `</ChannelFunction>`
      ),
      wheels
    )
    const slots = profile!.modes[0]!.channels[0]!.slots!
    expect(slots.map((s) => [s.from, s.name])).toEqual([
      [0, 'Open'],
      [10, 'Red'],
      [20, 'Blue'],
    ])
    // An unspecified slot colour is white by definition, which for the open
    // position of a colour wheel is the right answer rather than a guess.
    expect(slots[0]!.colour).toBe('#ffffff')
    expect(slots[1]!.colour.slice(0, 3)).toBe('#ff')
    expect(slots[2]!.colour.slice(5, 7)).toBe('ff')
  })

  it('skips a slot index that is out of range instead of guessing', () => {
    const profile = simple(
      channel(
        '1',
        'Color1',
        'Head',
        `<ChannelFunction Attribute="Color1" DMXFrom="0/1" Wheel="ColorWheel">` +
          `<ChannelSet Name="Ghost" DMXFrom="0/1" WheelSlotIndex="9"/>` +
          `<ChannelSet Name="Red" DMXFrom="10/1" WheelSlotIndex="2"/>` +
          `</ChannelFunction>`
      ),
      wheels
    )
    expect(profile!.modes[0]!.channels[0]!.slots!.map((s) => s.name)).toEqual(['Red'])
  })

  it('leaves slots off a channel that selects no wheel', () => {
    expect(simple(channel('1', 'Dimmer'))!.modes[0]!.channels[0]!.slots).toBeUndefined()
  })
})

describe('geometry references — the multi-cell case', () => {
  /** Four cells, each of which is the same three channels at its own offset. */
  const bar = (channelXml: string) =>
    parse(
      `<FixtureType Name="Bar" Manufacturer="Test"><Geometries>` +
        `<Geometry Name="Body"/>` +
        `<Geometry Name="Cell"><Beam Name="CellBeam"/></Geometry>` +
        [1, 4, 7, 10]
          .map(
            (offset) =>
              `<GeometryReference Name="Cell${offset}" Geometry="Cell">` +
              `<Break DMXBreak="1" DMXOffset="${offset}"/></GeometryReference>`
          )
          .join('') +
        `</Geometries>` +
        `<DMXModes><DMXMode Name="RGB"><DMXChannels>${channelXml}</DMXChannels></DMXMode></DMXModes>` +
        `</FixtureType>`
    )

  it('instantiates a referenced geometry once per reference', () => {
    // Without this a 4-cell bar reports a 3-channel footprint, and the
    // collision check happily patches something on top of cells 2 to 4.
    const profile = bar(
      channel('1', 'ColorAdd_R', 'Cell') +
        channel('2', 'ColorAdd_G', 'Cell') +
        channel('3', 'ColorAdd_B', 'Cell')
    )
    const mode = profile!.modes[0]!
    expect(mode.channels).toHaveLength(12)
    expect(mode.footprint).toBe(12)
    expect(mode.channels.filter((c) => c.attribute === 'ColorAdd_R').map((c) => c.offsets)).toEqual(
      [[1], [4], [7], [10]]
    )
  })

  it('follows a channel that names the reference rather than the geometry', () => {
    const profile = bar(channel('1', 'ColorAdd_R', 'Cell7'))
    expect(profile!.modes[0]!.channels.map((c) => c.offsets)).toEqual([[7]])
  })

  it('reaches a nested geometry through its top-level ancestor', () => {
    const profile = bar(channel('1,2', 'Dimmer', 'CellBeam'))
    expect(profile!.modes[0]!.channels.map((c) => c.offsets)).toEqual([
      [1, 2],
      [4, 5],
      [7, 8],
      [10, 11],
    ])
  })

  it('leaves an unreferenced geometry alone', () => {
    const profile = bar(channel('13', 'Dimmer', 'Body'))
    expect(profile!.modes[0]!.channels.map((c) => c.offsets)).toEqual([[13]])
  })

  it('takes break and offset from the reference when the channel says Overwrite', () => {
    const profile = parse(
      `<FixtureType Name="Bar" Manufacturer="Test"><Geometries>` +
        `<Geometry Name="Cell"/>` +
        `<GeometryReference Name="A" Geometry="Cell">` +
        `<Break DMXBreak="1" DMXOffset="1"/><Break DMXBreak="2" DMXOffset="5"/></GeometryReference>` +
        `</Geometries><DMXModes><DMXMode Name="M"><DMXChannels>` +
        `<DMXChannel DMXBreak="Overwrite" Offset="1" Geometry="Cell">` +
        `<LogicalChannel Attribute="Dimmer"><ChannelFunction DMXFrom="0/1"/></LogicalChannel>` +
        `</DMXChannel></DMXChannels></DMXMode></DMXModes></FixtureType>`
    )
    // The last Break child is the one that supplies both for "Overwrite".
    expect(profile!.modes[0]!.channels).toEqual([
      expect.objectContaining({ offsets: [5], dmxBreak: 2 }),
    ])
  })
})

describe('physical data', () => {
  const physical = (extra: string) =>
    parse(
      `<FixtureType Name="X" Manufacturer="Y">${extra}` +
        `<DMXModes><DMXMode Name="M"><DMXChannels>${channel('1', 'Dimmer')}</DMXChannels>` +
        `</DMXMode></DMXModes></FixtureType>`
    )!.physical

  it('reads weight in kilograms', () => {
    expect(
      physical(
        `<PhysicalDescriptions><Properties><Weight Value="21.5"/></Properties>` +
          `</PhysicalDescriptions>`
      ).weight
    ).toBe(21.5)
  })

  it('prefers the fixture-wide power figure to the beam', () => {
    const result = physical(
      `<PhysicalDescriptions><Properties><PowerConsumption Value="450"/></Properties>` +
        `</PhysicalDescriptions><Geometries><Beam Name="B" PowerConsumption="1000"/></Geometries>`
    )
    expect(result.watts).toBe(450)
  })

  it('falls back to the beam when the fixture does not state one', () => {
    expect(physical(`<Geometries><Beam Name="B" PowerConsumption="575"/></Geometries>`).watts).toBe(
      575
    )
  })

  it('says nothing rather than reporting the spec default as a fact', () => {
    // PowerConsumption defaults to 1000 W, so an unset one is
    // indistinguishable from a 1 kW lamp. Reporting it would put a fictional
    // number straight into a rig's power total.
    expect(physical(`<Geometries><Beam Name="B"/></Geometries>`).watts).toBeUndefined()
    expect(physical(``).weight).toBeUndefined()
  })

  it('takes the widest horizontal extent across the parts', () => {
    // Base is widest across, head is longest fore-and-aft: a fixture hangs
    // either way round, so the bar it eats is the larger of the two.
    const result = physical(
      `<Models><Model Name="Base" Length="0.32" Width="0.40" Height="0.20"/>` +
        `<Model Name="Head" Length="0.36" Width="0.25" Height="0.45"/></Models>`
    )
    expect(result.width).toBe(0.4)
    expect(result.height).toBe(0.45)
  })

  it('reads the beam angle', () => {
    expect(physical(`<Geometries><Beam Name="B" BeamAngle="14.5"/></Geometries>`).beamAngle).toBe(
      14.5
    )
  })
})

describe('units for the readout', () => {
  it('takes the physical unit from the attribute definitions', () => {
    const profile = simple(
      channel('1,2', 'Pan'),
      `<AttributeDefinitions><Attributes>` +
        `<Attribute Name="Pan" Pretty="P" PhysicalUnit="Angle"/>` +
        `</Attributes></AttributeDefinitions>`
    )
    expect(profile!.modes[0]!.channels[0]!.unit).toBe('°')
  })

  it('knows the handful that matter when a builder leaves it unset', () => {
    expect(simple(channel('1,2', 'Tilt'))!.modes[0]!.channels[0]!.unit).toBe('°')
    expect(simple(channel('1', 'Dimmer'))!.modes[0]!.channels[0]!.unit).toBe('%')
  })

  it('leaves it empty rather than inventing one', () => {
    expect(simple(channel('1', 'Shutter1'))!.modes[0]!.channels[0]!.unit).toBe('')
  })
})

describe('a profile nobody here wrote', () => {
  /**
   * Everything above builds its own XML, which proves the parser agrees with
   * the person who wrote the parser. This one came out of BlenderDMX (see
   * `__fixtures__/README.md`) and is the check that the agreement is with
   * GDTF rather than with itself.
   */
  const real = parseGdtfProfile(new DOMParser().parseFromString(realProfileXml, 'application/xml'))!

  it('reads it at all', () => {
    expect(real).not.toBeNull()
    expect(real.manufacturer).toBe('BlenderDMX')
    expect(real.name).toBe('LED PAR 64 RGBW')
  })

  it('finds the dimmer and the emitters, in order', () => {
    const mode = real.modes[0]!
    expect(mode.name).toBe('Default')
    expect(mode.footprint).toBe(5)
    expect(mode.channels.map((c) => [c.attribute, c.offsets[0]])).toEqual([
      ['Dimmer', 1],
      ['ColorAdd_R', 2],
      ['ColorAdd_G', 3],
      ['ColorAdd_B', 4],
      ['ColorAdd_W', 5],
    ])
  })

  it('reaches a channel hung on a geometry nested under the body', () => {
    // Every channel in this file says Geometry="Beam", which is a child of
    // the top-level "Body" — not a top-level geometry itself.
    expect(real.modes[0]!.channels.every((c) => c.geometry === 'Beam')).toBe(true)
  })

  it('is not fooled by a channel set that names slot zero', () => {
    // This file writes WheelSlotIndex="0" on channel sets of channels that
    // select no wheel at all. Reading that as "the first slot" would put a
    // colour on a dimmer.
    expect(real.modes[0]!.channels.every((c) => c.slots === undefined)).toBe(true)
  })

  it('takes power and beam angle from the beam geometry', () => {
    expect(real.physical.watts).toBe(216)
    expect(real.physical.beamAngle).toBe(60)
  })

  it('declines to report the zero this file gives for weight', () => {
    // `<Weight Value="0.000000"/>` is a builder default, not a 0 kg fixture.
    expect(real.physical.weight).toBeUndefined()
  })

  it('sizes it like a PAR 64', () => {
    // Body 0.322 × 0.266 × 0.297, yoke 0.296 × 0.058 × 0.203.
    expect(real.physical.width).toBeCloseTo(0.322, 3)
    expect(real.physical.height).toBeCloseTo(0.297, 3)
  })

  it('does not take PhysicalUnit="None" as a unit', () => {
    const dimmer = real.modes[0]!.channels[0]!
    expect(dimmer.attribute).toBe('Dimmer')
    expect(dimmer.unit).toBe('%')
  })
})

describe('files that are not what they claim', () => {
  it('returns null when there is no fixture type at all', () => {
    expect(parse(`<Nothing/>`)).toBeNull()
  })

  it('returns a profile with no modes rather than nothing', () => {
    // "This file has no DMX modes" is a better thing to be able to say than
    // "this file is broken".
    const profile = parse(`<FixtureType Name="X" Manufacturer="Y"><DMXModes/></FixtureType>`)
    expect(profile).toMatchObject({ name: 'X', manufacturer: 'Y', modes: [] })
  })

  it('skips a mode with nothing addressable in it', () => {
    const profile = simple(channel('None', 'Control'))
    expect(profile!.modes).toEqual([])
  })
})
