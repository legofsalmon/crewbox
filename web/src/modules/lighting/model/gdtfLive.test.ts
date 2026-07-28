import { describe, expect, it } from 'vitest'
import type { GdtfChannel } from './gdtf'
import {
  channelAddresses,
  channelReadout,
  decodeChannel,
  decodeSlot,
  fixtureColour,
  fixtureIntensity,
  fixtureOrientation,
  intensityAddresses,
  readChannel,
} from './gdtfLive'
import { emptyFixture, type Fixture, type FixtureType } from './types'

/**
 * What a profile lets the live view say that it couldn't say before.
 *
 * Every case here has a "without a profile" counterpart in live.test.ts —
 * the point of this layer is the difference between the two, so the tests
 * are written around what changes.
 */

const ch = (over: Partial<GdtfChannel> & Pick<GdtfChannel, 'offsets'>): GdtfChannel => ({
  attribute: 'Dimmer',
  geometry: 'Head',
  dmxBreak: 1,
  unit: '',
  ...over,
})

const typeWith = (channels: GdtfChannel[], over: Partial<FixtureType> = {}): FixtureType[] => [
  {
    id: 'head.gdtf',
    name: 'Head',
    modes: [{ name: 'Standard', footprint: 16, channels }],
    ...over,
  },
]

const fixture = (over: Partial<Fixture> = {}): Fixture => ({
  ...emptyFixture(),
  id: 'f1',
  typeId: 'head.gdtf',
  mode: 'Standard',
  universe: 1,
  address: 1,
  footprint: 16,
  ...over,
})

const levels = (values: Record<number, number>): Map<number, Uint8Array> => {
  const slots = new Uint8Array(512)
  for (const [address, value] of Object.entries(values)) slots[Number(address) - 1] = value
  return new Map([[1, slots]])
}

describe('finding a channel on the wire', () => {
  it('places offsets from the fixture start address', () => {
    expect(channelAddresses(ch({ offsets: [1, 2] }), 100)).toEqual([100, 101])
    expect(channelAddresses(ch({ offsets: [5] }), 1)).toEqual([5])
  })

  it('refuses a channel on another break rather than reading the wrong slot', () => {
    // crewbox patches a fixture at one address. A break-2 channel lives at
    // a second start address nothing here knows, so reading it from the
    // first would report a real number from the wrong fixture.
    expect(channelAddresses(ch({ offsets: [1], dmxBreak: 2 }), 100)).toBeNull()
  })

  it('refuses to run off the end of a universe', () => {
    expect(channelAddresses(ch({ offsets: [1, 2] }), 512)).toBeNull()
    expect(channelAddresses(ch({ offsets: [1] }), 0)).toBeNull()
  })

  it('combines a 16-bit channel MSB first', () => {
    const slots = new Uint8Array(512)
    slots[9] = 0x80
    slots[10] = 0x40
    expect(readChannel(ch({ offsets: [1, 2] }), 10, slots)).toBe(0x8040)
  })
})

describe('turning a value into what it means', () => {
  it('reads a plain channel as a proportion when it has no stored ranges', () => {
    expect(decodeChannel(ch({ offsets: [1] }), 128).physical).toBeCloseTo(128 / 255)
  })

  it('interpolates across the range a function covers', () => {
    const pan = ch({
      offsets: [1],
      attribute: 'Pan',
      functions: [{ name: 'Pan', from: 0, physicalFrom: -270, physicalTo: 270 }],
    })
    expect(decodeChannel(pan, 0).physical).toBe(-270)
    expect(decodeChannel(pan, 255).physical).toBe(270)
    expect(decodeChannel(pan, 128).physical).toBeCloseTo(1.06, 1)
  })

  it('stops a range where the next one starts, not where the channel ends', () => {
    // The spec defines a function's end as the next function's start minus
    // one. Reading it as the top of the channel puts every strobe rate on a
    // multi-function shutter wrong.
    const shutter = ch({
      offsets: [1],
      attribute: 'Shutter1',
      unit: 'Hz',
      functions: [
        { name: 'Closed', from: 0, physicalFrom: 0, physicalTo: 0 },
        { name: 'Strobe', from: 100, physicalFrom: 1, physicalTo: 21 },
        { name: 'Open', from: 200, physicalFrom: 0, physicalTo: 0 },
      ],
    })
    expect(decodeChannel(shutter, 100).physical).toBe(1)
    // 199 is the top of the strobe range, not 255.
    expect(decodeChannel(shutter, 199).physical).toBeCloseTo(21)
    expect(decodeChannel(shutter, 220)).toMatchObject({ physical: 0 })
    expect(decodeChannel(shutter, 220).fn!.name).toBe('Open')
  })

  it('picks the last slot at or below the value', () => {
    const wheel = ch({
      offsets: [1],
      attribute: 'Color1',
      slots: [
        { from: 0, name: 'Open', colour: '#ffffff' },
        { from: 10, name: 'Red', colour: '#ff0000' },
        { from: 20, name: 'Blue', colour: '#0000ff' },
      ],
    })
    expect(decodeSlot(wheel, 0)!.name).toBe('Open')
    expect(decodeSlot(wheel, 15)!.name).toBe('Red')
    expect(decodeSlot(wheel, 250)!.name).toBe('Blue')
    expect(decodeSlot(ch({ offsets: [1], attribute: 'Dimmer' }), 100)).toBeNull()
  })
})

describe('how bright, for real this time', () => {
  const types = typeWith([
    ch({ offsets: [1], attribute: 'Dimmer', unit: '%' }),
    ch({ offsets: [2, 3], attribute: 'Pan', unit: '°' }),
  ])

  it('reads the dimmer instead of the loudest channel', () => {
    // Pan at full and the dimmer out: a head slewing in the dark. Without
    // a profile this reads as a fixture at 100%.
    const dark = levels({ 1: 0, 2: 255, 3: 255 })
    expect(fixtureIntensity(fixture(), types, dark)).toEqual({ level: 0, basis: 'dimmer' })
  })

  it('scales a 16-bit dimmer by its own resolution', () => {
    const wide = typeWith([ch({ offsets: [1, 2], attribute: 'Dimmer' })])
    const half = levels({ 1: 0x80, 2: 0x00 })
    expect(fixtureIntensity(fixture(), wide, half)!.level).toBeCloseTo(0x8000 / 0xffff, 4)
  })

  it('takes the brightest cell of a multi-cell fixture', () => {
    // One pixel up is a bar that is on. Averaging would draw it as nearly
    // dark, which is the wrong answer to "is anything happening there".
    const bar = typeWith([
      ch({ offsets: [1], attribute: 'Dimmer', geometry: 'Cell1' }),
      ch({ offsets: [4], attribute: 'Dimmer', geometry: 'Cell2' }),
    ])
    expect(fixtureIntensity(fixture(), bar, levels({ 1: 0, 4: 255 }))!.level).toBe(1)
  })

  it('says so when it fell back to the peak', () => {
    // An LED with no master dimmer is a real fixture, and "the most being
    // asked of it" is still worth drawing — as long as it isn't called
    // intensity.
    const noDimmer = typeWith([ch({ offsets: [1], attribute: 'ColorAdd_R' })])
    expect(fixtureIntensity(fixture(), noDimmer, levels({ 1: 204 }))).toEqual({
      level: 0.8,
      basis: 'peak',
    })
    expect(fixtureIntensity(fixture(), [], levels({ 5: 255 }))).toEqual({
      level: 1,
      basis: 'peak',
    })
  })

  it('is null when this universe is not arriving', () => {
    expect(fixtureIntensity(fixture({ universe: 9 }), types, levels({ 1: 255 }))).toBeNull()
    expect(fixtureIntensity(fixture({ address: 0 }), types, levels({ 1: 255 }))).toBeNull()
  })
})

describe('which addresses decide whether a fixture was ever lit', () => {
  it('is the dimmer alone when the profile has one', () => {
    // A head parked at a position holds a non-zero pan value from the
    // moment the desk boots, so judging the whole footprint calls every
    // parked head "live" before anyone has put a light on stage.
    const types = typeWith([
      ch({ offsets: [1], attribute: 'Dimmer' }),
      ch({ offsets: [2, 3], attribute: 'Pan' }),
    ])
    expect(intensityAddresses(fixture({ address: 100 }), types)).toEqual([100])
  })

  it('collects every cell of a multi-cell fixture', () => {
    const bar = typeWith([
      ch({ offsets: [1], attribute: 'Dimmer' }),
      ch({ offsets: [5], attribute: 'Dimmer' }),
    ])
    expect(intensityAddresses(fixture(), bar)).toEqual([1, 5])
  })

  it('is null when nothing says, so the caller judges the footprint', () => {
    expect(intensityAddresses(fixture(), [])).toBeNull()
    expect(
      intensityAddresses(fixture(), typeWith([ch({ offsets: [1], attribute: 'ColorAdd_R' })]))
    ).toBeNull()
  })
})

describe('colour', () => {
  const rgbw = typeWith([
    ch({ offsets: [1], attribute: 'ColorAdd_R' }),
    ch({ offsets: [2], attribute: 'ColorAdd_G' }),
    ch({ offsets: [3], attribute: 'ColorAdd_B' }),
    ch({ offsets: [4], attribute: 'ColorAdd_W' }),
  ])

  it('adds the emitters that are up', () => {
    expect(fixtureColour(fixture(), rgbw, levels({ 1: 255 }))).toEqual({
      css: '#ff0000',
      from: ['additive'],
    })
    expect(fixtureColour(fixture(), rgbw, levels({ 1: 255, 2: 255 }))!.css).toBe('#ffff00')
    expect(fixtureColour(fixture(), rgbw, levels({ 4: 255 }))!.css).toBe('#ffffff')
  })

  it('keeps the hue when the emitters are low', () => {
    // Red at 10% is still red. The plot dims the fixture separately, so
    // scaling the colour too would make every low state look grey.
    expect(fixtureColour(fixture(), rgbw, levels({ 1: 26 }))!.css).toBe('#ff0000')
  })

  it('says nothing when every emitter is out', () => {
    expect(fixtureColour(fixture(), rgbw, levels({}))).toBeNull()
  })

  it('subtracts CMY from white', () => {
    const cmy = typeWith([
      ch({ offsets: [1], attribute: 'ColorSub_C' }),
      ch({ offsets: [2], attribute: 'ColorSub_M' }),
      ch({ offsets: [3], attribute: 'ColorSub_Y' }),
    ])
    // Full cyan flag takes the red out, leaving cyan.
    expect(fixtureColour(fixture(), cmy, levels({ 1: 255 }))).toEqual({
      css: '#00ffff',
      from: ['subtractive'],
    })
    // Cyan and magenta together leave blue.
    expect(fixtureColour(fixture(), cmy, levels({ 1: 255, 2: 255 }))!.css).toBe('#0000ff')
  })

  it('leaves an open CMY unstated rather than calling it white', () => {
    const cmy = typeWith([ch({ offsets: [1], attribute: 'ColorSub_C' })])
    expect(fixtureColour(fixture(), cmy, levels({}))).toBeNull()
  })

  it('takes the colour off a wheel', () => {
    const wheel = typeWith([
      ch({
        offsets: [1],
        attribute: 'Color1',
        slots: [
          { from: 0, name: 'Open', colour: '#ffffff' },
          { from: 10, name: 'Congo', colour: '#3300ff' },
        ],
      }),
    ])
    expect(fixtureColour(fixture(), wheel, levels({ 1: 12 }))).toEqual({
      css: '#3300ff',
      from: ['wheel'],
    })
  })

  it('runs a wheel over whatever the mixing produced', () => {
    const both = typeWith([
      ch({ offsets: [1], attribute: 'ColorAdd_R' }),
      ch({ offsets: [2], attribute: 'ColorAdd_G' }),
      ch({ offsets: [3], attribute: 'ColorAdd_B' }),
      ch({
        offsets: [4],
        attribute: 'Color1',
        slots: [
          { from: 0, name: 'Open', colour: '#ffffff' },
          { from: 10, name: 'Red', colour: '#ff0000' },
        ],
      }),
    ])
    const result = fixtureColour(fixture(), both, levels({ 1: 255, 2: 255, 3: 255, 4: 20 }))
    expect(result).toEqual({ css: '#ff0000', from: ['additive', 'wheel'] })
  })

  it('says nothing without a profile', () => {
    expect(fixtureColour(fixture(), [], levels({ 1: 255 }))).toBeNull()
  })
})

describe('where a head is pointed', () => {
  it('reads the profile degrees', () => {
    const types = typeWith([
      ch({
        offsets: [1, 2],
        attribute: 'Pan',
        unit: '°',
        functions: [{ name: 'Pan', from: 0, physicalFrom: -270, physicalTo: 270 }],
      }),
      ch({
        offsets: [3, 4],
        attribute: 'Tilt',
        unit: '°',
        functions: [{ name: 'Tilt', from: 0, physicalFrom: -135, physicalTo: 135 }],
      }),
    ])
    const centred = levels({ 1: 0x80, 2: 0, 3: 0x80, 4: 0 })
    const orientation = fixtureOrientation(fixture(), types, centred)!
    expect(orientation.pan).toBeCloseTo(0, 1)
    expect(orientation.tilt).toBeCloseTo(0, 1)
  })

  it('spreads a profile that never stated its range over a full turn', () => {
    // PhysicalFrom 0 to PhysicalTo 1 is GDTF's default, not a claim that
    // the head moves one degree.
    const vague = typeWith([ch({ offsets: [1], attribute: 'Pan' })])
    expect(fixtureOrientation(fixture(), vague, levels({ 1: 255 }))!.pan).toBeCloseTo(180, 0)
    expect(fixtureOrientation(fixture(), vague, levels({ 1: 0 }))!.pan).toBe(-180)
  })

  it('is null for a fixture that does not move', () => {
    const par = typeWith([ch({ offsets: [1], attribute: 'Dimmer' })])
    expect(fixtureOrientation(fixture(), par, levels({ 1: 255 }))).toBeNull()
    expect(fixtureOrientation(fixture(), [], levels({ 1: 255 }))).toBeNull()
  })

  it('reports one axis when the fixture only has one', () => {
    const scanner = typeWith([
      ch({
        offsets: [1],
        attribute: 'Pan',
        unit: '°',
        functions: [{ name: 'Pan', from: 0, physicalFrom: 0, physicalTo: 540 }],
      }),
    ])
    expect(fixtureOrientation(fixture(), scanner, levels({ 1: 255 }))).toEqual({
      pan: 540,
      tilt: null,
    })
  })
})

describe('the channel-by-channel readout', () => {
  const head = typeWith([
    ch({
      offsets: [3],
      attribute: 'Shutter1',
      functions: [
        { name: 'Closed', from: 0, physicalFrom: 0, physicalTo: 1 },
        { name: 'Open', from: 32, physicalFrom: 0, physicalTo: 1 },
      ],
    }),
    ch({ offsets: [1], attribute: 'Dimmer', unit: '%' }),
    ch({
      offsets: [4, 5],
      attribute: 'Pan',
      unit: '°',
      functions: [{ name: 'Pan', from: 0, physicalFrom: -270, physicalTo: 270 }],
    }),
  ])

  it('lists channels in address order, whatever order the profile had them', () => {
    const readings = channelReadout(fixture({ address: 10 }), head, levels({}))
    expect(readings.map((r) => [r.attribute, r.addresses])).toEqual([
      ['Dimmer', [10]],
      ['Shutter1', [12]],
      ['Pan', [13, 14]],
    ])
  })

  it('says a dimmer in percent and a pan in degrees', () => {
    // 0xC000 of 0xFFFF across −270°→270° is three quarters of the way: 135°.
    const readings = channelReadout(fixture(), head, levels({ 1: 153, 4: 0xc0, 5: 0 }))
    expect(readings.find((r) => r.attribute === 'Dimmer')!.value).toBe('60%')
    expect(readings.find((r) => r.attribute === 'Pan')!.value).toBe('135°')
  })

  it('keeps a decimal only where there is one', () => {
    // 0xD000 of 0xFFFF across −270°→270° lands on 168.77°.
    const readings = channelReadout(fixture(), head, levels({ 4: 0xd0, 5: 0 }))
    expect(readings.find((r) => r.attribute === 'Pan')!.value).toBe('168.8°')
  })

  it('gives a named state its name and not a meaningless percentage', () => {
    // A shutter's ranges are states. The builder left them at the default
    // 0→1 physical range, so "Open 45%" would be a number about nothing.
    const shutter = channelReadout(fixture(), head, levels({ 3: 200 })).find(
      (r) => r.attribute === 'Shutter1'
    )!
    expect(shutter.state).toBe('Open')
    expect(shutter.value).toBe('')
    // The raw DMX is still there for anyone who wants it.
    expect(shutter.raw).toBe(200)
  })

  it('carries a wheel slot and its colour', () => {
    const wheel = typeWith([
      ch({
        offsets: [1],
        attribute: 'Color1',
        slots: [
          { from: 0, name: 'Open', colour: '#ffffff' },
          { from: 10, name: 'Congo', colour: '#3300ff' },
        ],
      }),
    ])
    expect(channelReadout(fixture(), wheel, levels({ 1: 40 }))[0]).toMatchObject({
      state: 'Congo',
      colour: '#3300ff',
      value: '',
    })
  })

  it('still lists the channels when no levels are arriving', () => {
    // "This fixture has a pan channel at 13 and nothing is being sent to
    // it" is a useful thing to be able to read off a phone.
    const readings = channelReadout(fixture(), head, new Map())
    expect(readings).toHaveLength(3)
    expect(readings.every((r) => r.raw === null && r.value === '')).toBe(true)
  })

  it('marks a channel it cannot place rather than hiding it', () => {
    const split = typeWith([
      ch({ offsets: [1], attribute: 'Dimmer' }),
      ch({ offsets: [1], attribute: 'Zoom', dmxBreak: 2 }),
    ])
    const zoom = channelReadout(fixture(), split, levels({ 1: 255 })).find(
      (r) => r.attribute === 'Zoom'
    )!
    expect(zoom.addresses).toBeNull()
    expect(zoom.raw).toBeNull()
  })

  it('is empty without a profile, rather than inventing rows', () => {
    expect(channelReadout(fixture(), [], levels({ 1: 255 }))).toEqual([])
  })
})
