// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { strToU8, zipSync } from 'fflate'

/**
 * What an import actually inflates.
 *
 * The outer archive is filtered for a stated reason — one 10 MB festival rig
 * carried 218 .3ds model files against a single scene XML — and the *inner*
 * GDTF unzip was not. So every embedded profile's 3D models, gobo wheels and
 * thumbnails were inflated in full to reach one description.xml: several
 * megabytes per fixture type, on the phone somebody is holding at the top of
 * a ladder, for files nothing draws.
 *
 * Asserted by recording what `unzipSync` is asked to do, rather than by
 * timing it — 7 MB of test data compresses to nothing and inflates in
 * microseconds, so a stopwatch here measures the fixture and not the fix.
 */

const seen = vi.hoisted(() => [] as Array<{ filter?: (f: Entry) => boolean }>)

interface Entry {
  name: string
  originalSize: number
}

vi.mock('fflate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fflate')>()
  return {
    ...actual,
    unzipSync: (data: Uint8Array, opts?: { filter?: (f: Entry) => boolean }) => {
      seen.push(opts ?? {})
      return actual.unzipSync(data, opts as Parameters<typeof actual.unzipSync>[1])
    },
  }
})

const { parseMvr } = await import('./mvr')

const gdtfWithModels = (): Uint8Array =>
  zipSync({
    'description.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><GDTF DataVersion="1.2">` +
        `<FixtureType Name="Heavy" Manufacturer="Robe"><DMXModes>` +
        `<DMXMode Name="Mode 1" Geometry="Base"><DMXChannels>` +
        `<DMXChannel DMXBreak="1" Offset="1" Geometry="Base"/>` +
        `</DMXChannels></DMXMode></DMXModes></FixtureType></GDTF>`
    ),
    'models/3ds/base.3ds': new Uint8Array(64),
    'wheels/gobo1.png': new Uint8Array(64),
  })

const mvrWith = (profile: Uint8Array): Uint8Array =>
  zipSync({
    'GeneralSceneDescription.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><GeneralSceneDescription verMajor="1" verMinor="5">` +
        `<Scene><Layers><Layer name="Overhead" uuid="l-1"><ChildList>` +
        `<Fixture name="Spot 1" uuid="u-1">` +
        `<Matrix>{1,0,0}{0,1,0}{0,0,1}</Matrix>` +
        `<GDTFSpec>Heavy.gdtf</GDTFSpec><GDTFMode>Mode 1</GDTFMode>` +
        `<Addresses><Address break="0">1</Address></Addresses>` +
        `<FixtureID>1</FixtureID><UnitNumber>1</UnitNumber>` +
        `</Fixture></ChildList></Layer></Layers></Scene></GeneralSceneDescription>`
    ),
    'Heavy.gdtf': profile,
  })

describe('inflating an MVR', () => {
  it('asks for the description and nothing else out of each profile', () => {
    seen.length = 0
    const result = parseMvr(mvrWith(gdtfWithModels()))
    expect(result.types[0]?.name).toBe('Robe Heavy')

    // Both unzips: the archive, then the profile inside it.
    expect(seen).toHaveLength(2)
    const inner = seen[1]!.filter
    expect(inner).toBeTypeOf('function')
    expect(inner!({ name: 'description.xml', originalSize: 4096 })).toBe(true)
    expect(inner!({ name: 'models/3ds/base.3ds', originalSize: 4_000_000 })).toBe(false)
    expect(inner!({ name: 'wheels/gobo1.png', originalSize: 2_000_000 })).toBe(false)
  })

  it('refuses an entry whose declared size is not a real file', () => {
    // A zip's header is whatever wrote it. Somebody opening a file a
    // stranger emailed them should not be handed a gigabyte to inflate.
    seen.length = 0
    parseMvr(mvrWith(gdtfWithModels()))
    for (const call of seen) {
      expect(call.filter!({ name: 'description.xml', originalSize: 4e9 })).toBe(false)
      expect(call.filter!({ name: 'GeneralSceneDescription.xml', originalSize: 4e9 })).toBe(false)
    }
  })
})
