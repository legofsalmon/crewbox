// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import fixture from './__fixtures__/screen-setup.xml?raw'
import {
  buildView,
  decodeSource,
  deviceLabel,
  meshBoundary,
  parseScreenSetup,
  rectFromPts,
  warpDeviation,
} from './screenSetup.ts'

const checksOf = (name: string) => {
  const view = buildView(parseScreenSetup(fixture))
  const slice = [...view.byId.values()].find((s) => s.layer.name === name)
  if (!slice) throw new Error(`no slice ${name}`)
  return slice.checks.map((c) => `${c.kind}: ${c.text}`)
}

describe('parseScreenSetup', () => {
  it('reads a saved preset: name, version, composition, screens and devices', () => {
    const setup = parseScreenSetup(fixture)
    expect(setup.name).toBe('Fixture Stage')
    expect(setup.version).toBe('Resolume Arena 7.27.1')
    expect(setup.format).toBe('preset')
    expect(setup.comp).toEqual({ w: 1920, h: 1080 })
    expect(setup.screens.map((s) => s.name)).toEqual(['LED', 'Side'])

    const [led, side] = setup.screens
    expect(led!.device).toMatchObject({ type: 'Virtual', w: 1920, h: 1080, fullscreen: false })
    expect(side!.device).toMatchObject({
      type: 'Display',
      name: 'Display 2',
      w: 1920,
      h: 1080,
      fullscreen: true,
    })
    expect(deviceLabel(side!)).toBe('Display · Display 2 · 1920×1080 · fullscreen')
  })

  it('reads slices with the defaults the preferences file leaves out', () => {
    const led = parseScreenSetup(fixture).screens[0]!
    expect(led.layers.map((l) => l.name)).toEqual([
      'FAR LEFT',
      'LEFT',
      'CENTER',
      'RIGHT TOP',
      'RIGHT BOTTOM',
      'FULL (spare)',
      'Camera hole',
    ])
    const left = led.layers[1]!
    // No <Param name="Enabled"> at all means enabled; no warper means no warp.
    expect(left.enabled).toBe(true)
    expect(left.warp).toBeNull()
    expect(left.warpSummary).toBeNull()
    expect(left.input!.bbox).toEqual({ x: 480, y: 0, w: 479, h: 1080 })
    expect(left.output!.bbox).toEqual({ x: 481, y: 0, w: 479, h: 1080 })
    expect(led.layers[5]!.enabled).toBe(false)
  })

  it('decodes input sources the way Arena numbers them', () => {
    const led = parseScreenSetup(fixture).screens[0]!
    expect(led.layers[0]!.source).toMatchObject({ kind: 'composition', label: 'Composition' })
    expect(led.layers[1]!.source).toMatchObject({ kind: 'group', index: 2, label: 'Group 2' })
    expect(led.layers[2]!.source).toMatchObject({ kind: 'layer', index: 4, label: 'Layer 4' })
    expect(decodeSource('2:9')).toMatchObject({ kind: 'other', label: 'Source 2:9' })
    expect(decodeSource('')).toMatchObject({ kind: 'other', label: 'Composition' })
  })

  it('drops an untouched warp mesh but remembers what it was', () => {
    const farLeft = parseScreenSetup(fixture).screens[0]!.layers[0]!
    expect(farLeft.warp).toBeNull()
    expect(farLeft.warpSummary).toBe('Linear 4×4 · untouched')
    expect(farLeft.cornerPinEdited).toBe(false)
  })

  it('keeps a mask as its contour', () => {
    const mask = parseScreenSetup(fixture).screens[0]!.layers[6]!
    expect(mask.kind).toBe('Mask')
    expect(mask.invert).toBe(true)
    expect(mask.input!.normalized).toBe(true)
    expect(mask.contour).toMatchObject({ segments: 'LLLL', closed: true })
    expect(mask.contour!.points).toHaveLength(4)
  })

  it('reads a rotated slice as its own width and height', () => {
    const portrait = parseScreenSetup(fixture).screens[1]!.layers[0]!
    expect(portrait.output!.w).toBe(1920)
    expect(portrait.output!.h).toBe(1080)
    expect(portrait.output!.bbox).toEqual({ x: 0, y: 0, w: 1080, h: 1920 })
    expect(portrait.output!.rot).toBeCloseTo(-Math.PI / 2)
  })

  it('reads the stripped preferences format too', () => {
    const prefs = `<?xml version="1.0" encoding="utf-8"?>
<ScreenSetup name="ScreenSetup">
  <CurrentCompositionTextureSize width="3840" height="2160"/>
  <screens>
    <Screen name="Upstage" uniqueId="1">
      <Params name="Params"><Param name="Name" T="STRING" default="" value="Upstage"/></Params>
      <layers>
        <Slice uniqueId="2">
          <Params name="Common"><Param name="Name" T="STRING" default="Layer" value="Right"/></Params>
          <InputRect orientation="0"><v x="0" y="0"/><v x="3840" y="0"/><v x="3840" y="768"/><v x="0" y="768"/></InputRect>
          <OutputRect orientation="0"><v x="0" y="0"/><v x="3840" y="0"/><v x="3840" y="768"/><v x="0" y="768"/></OutputRect>
        </Slice>
      </layers>
      <OutputDevice><OutputDeviceDisplay name="Display 2" deviceId="Display 2" idHash="7" fullscreen="1" width="3840" height="2160"/></OutputDevice>
    </Screen>
  </screens>
</ScreenSetup>`
    const setup = parseScreenSetup(prefs, 'AdvancedOutput.xml')
    expect(setup.format).toBe('preferences')
    expect(setup.name).toBe('AdvancedOutput')
    expect(setup.version).toBe('unknown version')
    expect(setup.screens[0]!.layers[0]!.output!.w).toBe(3840)
  })

  it('refuses files that are not an Advanced Output preset', () => {
    expect(() => parseScreenSetup('<Composition name="x"/>')).toThrow(/not an Advanced Output/)
    expect(() => parseScreenSetup('<XmlState name="x"><Nothing/></XmlState>')).toThrow(
      /no <ScreenSetup>/
    )
  })
})

describe('buildView', () => {
  it('flags a near-miss gap, an overlap and a sub-pixel placement', () => {
    expect(checksOf('FAR LEFT')).toEqual(['gap: 1 px gap to “LEFT” (right)'])
    expect(checksOf('LEFT')).toEqual([
      'gap: 1 px gap to “FAR LEFT” (left)',
      'overlap: overlaps “CENTER” by 2×1080 px',
    ])
    expect(checksOf('RIGHT TOP')).toEqual(['gap: 3 px gap to “RIGHT BOTTOM” (below)'])
    expect(checksOf('RIGHT BOTTOM')).toEqual([
      'subpx: output not on whole pixels (1440.5, 543 · 479.5×537)',
      'gap: 0.5 px gap to “CENTER” (left)',
      'gap: 3 px gap to “RIGHT TOP” (above)',
    ])
  })

  it('leaves disabled slices and masks out of the overlap and gap checks', () => {
    // The spare full-screen slice overlaps everything and is switched off.
    expect(checksOf('FULL (spare)')).toEqual([])
    expect(checksOf('Camera hole')).toEqual([])
  })

  it('counts what the summary line shows', () => {
    const view = buildView(parseScreenSetup(fixture))
    expect(view.stats).toEqual({
      screens: 2,
      slices: 7,
      masks: 1,
      other: 0,
      disabled: 1,
      outside: 1,
      scaled: 0,
      warped: 0,
      subpx: 1,
      overlaps: 2,
      gaps: 5,
    })
    // The rotated slice hangs 1920 px down a 1080 px display.
    const portrait = view.screens[1]!.slices[0]!
    expect(portrait.outOutside).toBe(true)
    expect(portrait.inOutside).toBe(false)
  })

  it('draws a mask by its contour and a slice by its output rectangle', () => {
    const view = buildView(parseScreenSetup(fixture))
    const led = view.screens[0]!
    expect(led.slices[6]!.outPoly).toHaveLength(4)
    expect(led.slices[6]!.inPoly).toBeNull()
    expect(led.slices[0]!.outPoly).toEqual(led.slices[0]!.layer.output!.pts)
    expect(led.bounds).toEqual({ x: 0, y: 0, w: 1920, h: 1080 })
    expect(led.boundsDerived).toBe(false)
  })

  it('survives a trip through JSON, which is how it is stored and synced', () => {
    const setup = parseScreenSetup(fixture)
    const again = JSON.parse(JSON.stringify(setup))
    expect(buildView(again).stats).toEqual(buildView(setup).stats)
  })
})

describe('geometry', () => {
  it('measures an edited mesh by how far it strays from a flat grid', () => {
    const flat = []
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) flat.push({ x: i * 100, y: j * 50 })
    expect(warpDeviation(3, 3, flat)).toBe(0)
    // Drag the centre point: the corners still describe a flat grid, and the
    // deviation is how far the centre left it.
    const bent = flat.map((p, i) => (i === 4 ? { x: p.x + 12, y: p.y } : p))
    expect(warpDeviation(3, 3, bent)).toBe(12)
    expect(warpDeviation(3, 3, flat.slice(1))).toBeNull()
  })

  it('outlines a linear mesh through its edge points', () => {
    const verts = []
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) verts.push({ x: i, y: j })
    const outline = meshBoundary({ mode: 'PM_LINEAR', cols: 3, rows: 3, verts })
    expect(outline).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 1 },
      { x: 2, y: 2 },
      { x: 1, y: 2 },
      { x: 0, y: 2 },
      { x: 0, y: 1 },
    ])
  })

  it('reports edge lengths for a rectangle from its corners', () => {
    const rect = rectFromPts(
      [
        { x: 0, y: 200 },
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 200 },
      ],
      -Math.PI / 2
    )
    expect(rect).toMatchObject({ w: 200, h: 100, normalized: false })
    expect(rectFromPts([{ x: 0, y: 0 }], 0)).toBeNull()
  })
})
