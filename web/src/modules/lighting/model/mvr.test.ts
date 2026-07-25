// @vitest-environment happy-dom
//
// The MVR parser uses DOMParser, which every browser and the Android webview
// have for free — worth a dev-only DOM here rather than shipping an XML
// parser to every phone on site.
import { zipSync, strToU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { gdtfModeFootprint, parseMvr, parseMvrMatrix } from './mvr'
import { fitPosition } from './placement'

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

describe('GDTF footprint', () => {
  const modeOf = (offsets: string[]) => {
    const xml = `<DMXMode><DMXChannels>${offsets
      .map((o) => `<DMXChannel Offset="${o}"/>`)
      .join('')}</DMXChannels></DMXMode>`
    return new DOMParser().parseFromString(xml, 'application/xml').documentElement
  }

  it('is the highest offset used', () => {
    expect(gdtfModeFootprint(modeOf(['1', '2', '3']))).toBe(3)
  })

  it('counts both bytes of a 16-bit channel', () => {
    // "15,16" is one coarse/fine pair occupying two slots.
    expect(gdtfModeFootprint(modeOf(['1', '15,16']))).toBe(16)
  })

  it('ignores virtual channels that occupy nothing', () => {
    expect(gdtfModeFootprint(modeOf(['1', 'None', '4']))).toBe(4)
  })
})

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
})
