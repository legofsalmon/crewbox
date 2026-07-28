// @vitest-environment happy-dom
//
// The MVR parser uses DOMParser, which every browser and the Android webview
// have for free — worth a dev-only DOM here rather than shipping an XML
// parser to every phone on site.
import { zipSync, strToU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { parseMvr, parseMvrMatrix } from './mvr'
import { fitPosition, isBar } from './placement'

/**
 * These build real ZIPs — an .mvr containing .gdtf archives — rather than
 * stubbing the unzip. The nesting is the part most likely to break, so it's
 * the part worth exercising.
 */

const gdtf = (manufacturer: string, name: string, modes: [string, string[]][]): Uint8Array => {
  const modeXml = modes
    .map(
      ([modeName, offsets]) =>
        `<DMXMode Name="${modeName}" Geometry="Base"><DMXChannels>` +
        offsets
          .map((offset) => `<DMXChannel DMXBreak="1" Offset="${offset}" Geometry="Base"/>`)
          .join('') +
        `</DMXChannels></DMXMode>`
    )
    .join('')
  return zipSync({
    'description.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><GDTF DataVersion="1.2">` +
        `<FixtureType Name="${name}" Manufacturer="${manufacturer}">` +
        `<DMXModes>${modeXml}</DMXModes></FixtureType></GDTF>`
    ),
  })
}

interface FixtureSpec {
  name: string
  spec: string
  mode: string
  address: number
  fixtureId: string
  unit: string
  matrix: string
}

const fixtureXml = (f: FixtureSpec) =>
  `<Fixture name="${f.name}" uuid="u-${f.name}">` +
  `<Matrix>${f.matrix}</Matrix>` +
  `<GDTFSpec>${f.spec}</GDTFSpec>` +
  `<GDTFMode>${f.mode}</GDTFMode>` +
  `<Addresses><Address break="0">${f.address}</Address></Addresses>` +
  `<FixtureID>${f.fixtureId}</FixtureID>` +
  `<UnitNumber>${f.unit}</UnitNumber>` +
  `</Fixture>`

const buildMvr = (
  layers: {
    name: string
    fixtures: FixtureSpec[]
    groups?: { name: string; fixtures: FixtureSpec[] }[]
  }[],
  profiles: Record<string, Uint8Array>
): Uint8Array => {
  const layerXml = layers
    .map(
      (layer) =>
        `<Layer name="${layer.name}" uuid="l-${layer.name}"><ChildList>` +
        layer.fixtures.map(fixtureXml).join('') +
        (layer.groups ?? [])
          .map(
            (group) =>
              `<GroupObject name="${group.name}"><ChildList>` +
              group.fixtures.map(fixtureXml).join('') +
              `</ChildList></GroupObject>`
          )
          .join('') +
        `</ChildList></Layer>`
    )
    .join('')

  return zipSync({
    'GeneralSceneDescription.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><GeneralSceneDescription verMajor="1" verMinor="5">` +
        `<Scene><Layers>${layerXml}</Layers></Scene></GeneralSceneDescription>`
    ),
    ...profiles,
  })
}

const sharpy = 'Clay Paky@Sharpy@v1.gdtf'
const aura = 'Martin@MAC Aura@v2.gdtf'

const IDENTITY = '{1,0,0}{0,1,0}{0,0,1}'

describe('MVR matrix', () => {
  it('reads the translation, converting millimetres to metres', () => {
    expect(parseMvrMatrix(`${IDENTITY}{-3000,6000,8000}`)).toEqual({ x: -3, y: 6, z: 8 })
  })

  it('tolerates whitespace and decimals', () => {
    expect(parseMvrMatrix('{1.0,0,0}{0,1.0,0}{0,0,1.0}{ 1500.5 , 0 , 0 }')).toMatchObject({
      x: 1.5005,
    })
  })

  it('returns null for a malformed matrix rather than guessing', () => {
    expect(parseMvrMatrix('{1,0,0}{0,1,0}')).toBeNull()
    expect(parseMvrMatrix('')).toBeNull()
  })
})

/*
 * Offsets, 16-bit pairs, virtual channels and geometry references are all
 * covered directly in gdtf.test.ts. What matters here is that a profile
 * missing the parts the decoder reads still yields a usable footprint —
 * the `gdtf()` helper above writes bare `<DMXChannel>` elements with no
 * logical channel at all, so every MVR test in this file exercises it.
 */

describe('MVR import', () => {
  it('reads fixtures with footprints from their GDTF profiles', () => {
    const mvr = buildMvr(
      [
        {
          name: 'Upstage Truss',
          fixtures: [
            {
              name: 'Sharpy 1',
              spec: sharpy,
              mode: 'Standard',
              address: 1,
              fixtureId: '101',
              unit: '1',
              matrix: `${IDENTITY}{-3000,6000,8000}`,
            },
          ],
        },
      ],
      { [sharpy]: gdtf('Clay Paky', 'Sharpy', [['Standard', ['1', '15,16']]]) }
    )

    const result = parseMvr(mvr)

    expect(result.fixtures).toHaveLength(1)
    expect(result.fixtures[0]).toMatchObject({
      name: 'Sharpy 1',
      layer: 'Upstage Truss',
      typeId: sharpy,
      mode: 'Standard',
      // Straight from the profile, not from anyone's typing.
      footprint: 16,
      universe: 1,
      address: 1,
      channel: '101',
      unit: '1',
      x: -3,
      y: 6,
    })
    expect(result.types[0]).toMatchObject({ name: 'Clay Paky Sharpy' })
    expect(result.warnings).toEqual([])
  })

  it('splits absolute addresses into universe and address', () => {
    const mvr = buildMvr(
      [
        {
          name: 'L',
          fixtures: [
            {
              name: 'A',
              spec: sharpy,
              mode: 'Standard',
              address: 537,
              fixtureId: '1',
              unit: '1',
              matrix: `${IDENTITY}{0,0,0}`,
            },
          ],
        },
      ],
      { [sharpy]: gdtf('Clay Paky', 'Sharpy', [['Standard', ['16']]]) }
    )
    expect(parseMvr(mvr).fixtures[0]).toMatchObject({ universe: 2, address: 25 })
  })

  it('uses a group name as the position when a fixture sits in one', () => {
    const mvr = buildMvr(
      [
        {
          name: 'Layer 1',
          fixtures: [],
          groups: [
            {
              name: 'SL Boom',
              fixtures: [
                {
                  name: 'B1',
                  spec: sharpy,
                  mode: 'Standard',
                  address: 1,
                  fixtureId: '1',
                  unit: '1',
                  matrix: `${IDENTITY}{0,0,0}`,
                },
              ],
            },
          ],
        },
      ],
      { [sharpy]: gdtf('Clay Paky', 'Sharpy', [['Standard', ['16']]]) }
    )
    // "SL Boom" beats "Layer 1" — the group is the real rigging position.
    expect(parseMvr(mvr).fixtures[0]!.layer).toBe('SL Boom')
  })

  it('warns rather than throwing when a GDTF profile is missing', () => {
    const mvr = buildMvr(
      [
        {
          name: 'L',
          fixtures: [
            {
              name: 'Unknown',
              spec: aura,
              mode: 'Extended',
              address: 1,
              fixtureId: '1',
              unit: '1',
              matrix: `${IDENTITY}{0,0,0}`,
            },
          ],
        },
      ],
      {}
    )
    const result = parseMvr(mvr)

    expect(result.fixtures).toHaveLength(1)
    // Honest default: 1 channel, flagged, rather than an invented count that
    // would make collision detection confidently wrong.
    expect(result.fixtures[0]).toMatchObject({ typeId: '', footprint: 1, mode: 'Extended' })
    expect(result.warnings.join(' ')).toMatch(/No GDTF profile for 1 fixture type/)
  })

  it('flags fixtures with no DMX address', () => {
    const mvr = buildMvr(
      [
        {
          name: 'L',
          fixtures: [
            {
              name: 'A',
              spec: sharpy,
              mode: 'Standard',
              address: 0,
              fixtureId: '1',
              unit: '1',
              matrix: `${IDENTITY}{0,0,0}`,
            },
          ],
        },
      ],
      { [sharpy]: gdtf('Clay Paky', 'Sharpy', [['Standard', ['16']]]) }
    )
    const result = parseMvr(mvr)
    expect(result.fixtures[0]).toMatchObject({ address: 0 })
    expect(result.warnings.join(' ')).toMatch(/1 fixture had no DMX address/)
  })

  it('rejects a ZIP that is not an MVR', () => {
    expect(() => parseMvr(zipSync({ 'readme.txt': strToU8('nope') }))).toThrow(/Not an MVR/)
  })
})

describe('position fitting', () => {
  it('fits a horizontal bar and orders fixtures along it', () => {
    const fitted = fitPosition([
      { x: 3, y: 6 },
      { x: -3, y: 6 },
      { x: 0, y: 6 },
    ])

    expect(fitted.x).toBeCloseTo(0)
    expect(fitted.y).toBeCloseTo(6)
    expect(Math.abs(fitted.rotation) % 180).toBeCloseTo(0)
    expect(fitted.length).toBeGreaterThan(6)
    // Left to right, regardless of the order they appeared in the file.
    expect(fitted.order).toEqual([1, 2, 0])
  })

  it('finds the angle of a diagonal position', () => {
    // A boom raked at 45°, which a bounding box would get wrong.
    const fitted = fitPosition([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ])
    expect(Math.abs(fitted.rotation)).toBeCloseTo(45)
    expect(fitted.length).toBeGreaterThan(2.8)
  })

  it('falls back to a default bar for coincident points', () => {
    const fitted = fitPosition([
      { x: 2, y: 2 },
      { x: 2, y: 2 },
    ])
    expect(fitted).toMatchObject({ x: 2, y: 2, rotation: 0, length: 12 })
  })

  it('handles an empty position', () => {
    expect(fitPosition([])).toMatchObject({ length: 12, order: [] })
  })

  it('measures how far off the line a scattered group sits', () => {
    // A role grouping across two trusses, as a real Capture export produces.
    const scatter = [
      { x: -4, y: 6 },
      { x: 4, y: 6 },
      { x: -4, y: 9 },
      { x: 4, y: 9 },
    ]
    expect(fitPosition(scatter).residual).toBeGreaterThan(1)
    expect(isBar(fitPosition(scatter), scatter.length)).toBe(false)
  })

  it('accepts a real truss', () => {
    const truss = [
      { x: -4, y: 6 },
      { x: 0, y: 6.05 },
      { x: 4, y: 6 },
    ]
    expect(isBar(fitPosition(truss), truss.length)).toBe(true)
  })

  it('refuses to call two points a bar', () => {
    // Any two points are exactly collinear, so the residual says nothing —
    // two hazers at opposite corners would draw a truss across the stage.
    const pair = [
      { x: -8, y: 7 },
      { x: 8, y: 7 },
    ]
    expect(fitPosition(pair).residual).toBe(0)
    expect(isBar(fitPosition(pair), pair.length)).toBe(false)
  })
})

describe('what the GDTF profiles bring with them', () => {
  /** A profile with real logical channels, models, a beam and two modes. */
  const profiled = zipSync({
    'description.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><GDTF DataVersion="1.2">` +
        `<FixtureType Name="Wash 300" Manufacturer="Test">` +
        `<PhysicalDescriptions><Properties><Weight Value="18.4"/>` +
        `<PowerConsumption Value="410"/></Properties></PhysicalDescriptions>` +
        `<Models><Model Name="Body" Length="0.36" Width="0.30" Height="0.48"/></Models>` +
        `<Geometries><Geometry Name="Base"><Beam Name="Beam" BeamAngle="21"/></Geometry></Geometries>` +
        `<DMXModes>` +
        `<DMXMode Name="Basic" Geometry="Base"><DMXChannels>` +
        `<DMXChannel DMXBreak="1" Offset="1" Geometry="Base">` +
        `<LogicalChannel Attribute="Dimmer"><ChannelFunction Attribute="Dimmer" DMXFrom="0/1"/>` +
        `</LogicalChannel></DMXChannel></DMXChannels></DMXMode>` +
        `<DMXMode Name="Extended" Geometry="Base"><DMXChannels>` +
        `<DMXChannel DMXBreak="1" Offset="1,2" Geometry="Base">` +
        `<LogicalChannel Attribute="Pan"><ChannelFunction Attribute="Pan" DMXFrom="0/1" ` +
        `PhysicalFrom="-270" PhysicalTo="270"/></LogicalChannel></DMXChannel>` +
        `<DMXChannel DMXBreak="1" Offset="3" Geometry="Base">` +
        `<LogicalChannel Attribute="Dimmer"><ChannelFunction Attribute="Dimmer" DMXFrom="0/1"/>` +
        `</LogicalChannel></DMXChannel></DMXChannels></DMXMode>` +
        `</DMXModes></FixtureType></GDTF>`
    ),
  })

  const importedIn = (mode: string) =>
    parseMvr(
      buildMvr(
        [
          {
            name: 'FOH',
            fixtures: [
              {
                name: 'Wash 1',
                spec: 'Test@Wash300.gdtf',
                mode,
                address: 1,
                fixtureId: '1',
                unit: '1',
                matrix: `${IDENTITY}{0,0,7000}`,
              },
            ],
          },
        ],
        { 'Test@Wash300.gdtf': profiled }
      )
    )

  it('brings the channel map through with the type', () => {
    const type = importedIn('Extended').types[0]!
    const extended = type.modes.find((m) => m.name === 'Extended')!
    expect(extended.footprint).toBe(3)
    expect(extended.channels).toEqual([
      expect.objectContaining({
        attribute: 'Pan',
        offsets: [1, 2],
        unit: '°',
        functions: [{ name: 'Pan', from: 0, physicalFrom: -270, physicalTo: 270 }],
      }),
      expect.objectContaining({ attribute: 'Dimmer', offsets: [3] }),
    ])
  })

  it('leaves the channel maps off modes nobody is patched in', () => {
    // A profile carries every mode the fixture has; a rig uses one. The
    // plot document syncs to every phone on site, so the other modes keep
    // their names and footprints and lose their channel definitions.
    const type = importedIn('Extended').types[0]!
    expect(type.modes.find((m) => m.name === 'Basic')!.channels).toBeUndefined()
    expect(type.modes.find((m) => m.name === 'Basic')!.footprint).toBe(1)
    expect(type.modes.find((m) => m.name === 'Extended')!.channels).toBeDefined()
  })

  it('follows which mode is in use', () => {
    const type = importedIn('Basic').types[0]!
    expect(type.modes.find((m) => m.name === 'Basic')!.channels).toBeDefined()
    expect(type.modes.find((m) => m.name === 'Extended')!.channels).toBeUndefined()
  })

  it('carries weight, power, size and beam angle', () => {
    expect(importedIn('Basic').types[0]).toMatchObject({
      name: 'Test Wash 300',
      weight: 18.4,
      watts: 410,
      width: 0.36,
      height: 0.48,
      beamAngle: 21,
    })
  })
})
