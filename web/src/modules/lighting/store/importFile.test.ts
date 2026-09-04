// @vitest-environment happy-dom
//
// importPlotFile reads a File and the MVR parser uses DOMParser, so this
// needs a DOM the same way mvr.test.ts does.
import { zipSync, strToU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { initPlot, snapshotPlot } from '../model/plotDoc'
import { importPlotFile } from './importFile'

/**
 * The re-import path, which is the one a designer actually takes: export,
 * import, change something, export again, import again. It used to add the
 * whole rig a second time.
 */

const gdtf = (name: string, footprint: number): Uint8Array =>
  zipSync({
    'description.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><GDTF DataVersion="1.2">` +
        `<FixtureType Name="${name}" Manufacturer="Clay Paky"><DMXModes>` +
        `<DMXMode Name="Standard" Geometry="Base"><DMXChannels>` +
        Array.from(
          { length: footprint },
          (_, i) => `<DMXChannel DMXBreak="1" Offset="${i + 1}" Geometry="Base"/>`
        ).join('') +
        `</DMXChannels></DMXMode></DMXModes></FixtureType></GDTF>`
    ),
  })

const SPEC = 'Clay Paky@Sharpy@v1.gdtf'
const IDENTITY = '{1,0,0}{0,1,0}{0,0,1}'

interface Head {
  uuid: string
  name: string
  address: number
  x: number
}

const mvrFile = (heads: Head[], layer = 'LX1'): File => {
  const fixtures = heads
    .map(
      (head) =>
        `<Fixture name="${head.name}" uuid="${head.uuid}">` +
        `<Matrix>${IDENTITY}{${head.x * 1000},0,8000}</Matrix>` +
        `<GDTFSpec>${SPEC}</GDTFSpec><GDTFMode>Standard</GDTFMode>` +
        `<Addresses><Address break="0">${head.address}</Address></Addresses>` +
        `<FixtureID>${head.name}</FixtureID><UnitNumber>0</UnitNumber></Fixture>`
    )
    .join('')
  const bytes = zipSync({
    'GeneralSceneDescription.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><GeneralSceneDescription verMajor="1" verMinor="5">` +
        `<Scene><Layers><Layer name="${layer}" uuid="l-1"><ChildList>${fixtures}` +
        `</ChildList></Layer></Layers></Scene></GeneralSceneDescription>`
    ),
    [SPEC]: gdtf('Sharpy', 16),
  })
  // happy-dom's File does not implement arrayBuffer over a Blob part the way
  // the browser does, so hand it one directly.
  const file = new File([bytes], 'rig.mvr')
  Object.defineProperty(file, 'arrayBuffer', {
    value: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  })
  return file
}

const newPlot = () => {
  const doc = new Y.Doc()
  initPlot(doc, { title: 'Main Stage', venue: 'Worthy Farm', date: '2026-06-24' })
  return doc
}

const rig: Head[] = [
  { uuid: 'f-1', name: '101', address: 1, x: -3 },
  { uuid: 'f-2', name: '102', address: 17, x: 0 },
  { uuid: 'f-3', name: '103', address: 33, x: 3 },
]

describe('importing an MVR twice', () => {
  it('updates the rig it already has rather than adding it again', async () => {
    const doc = newPlot()
    await importPlotFile(doc, mvrFile(rig))
    expect(snapshotPlot(doc).fixtures).toHaveLength(3)

    // The designer repatches one head and moves another, and re-exports.
    const revised: Head[] = [
      { uuid: 'f-1', name: '101', address: 101, x: -3 },
      { uuid: 'f-2', name: '102', address: 17, x: 2 },
      { uuid: 'f-3', name: '103', address: 33, x: 3 },
    ]
    const summary = await importPlotFile(doc, mvrFile(revised))

    const fixtures = snapshotPlot(doc).fixtures
    expect(fixtures).toHaveLength(3)
    expect(fixtures.find((f) => f.mvrUuid === 'f-1')?.address).toBe(101)
    expect(fixtures.find((f) => f.mvrUuid === 'f-2')?.x).toBe(2)
    expect(summary).toContain('3 updated, 0 new')
  })

  it('adds the fixtures the new file brought, and only those', async () => {
    const doc = newPlot()
    await importPlotFile(doc, mvrFile(rig))
    const summary = await importPlotFile(
      doc,
      mvrFile([...rig, { uuid: 'f-4', name: '104', address: 49, x: 6 }])
    )
    expect(snapshotPlot(doc).fixtures).toHaveLength(4)
    expect(summary).toContain('3 updated, 1 new')
  })

  it('leaves a fixture the new file dropped, and says it did', async () => {
    // Deleting is the designer's call. A sheet with one fixture too many is
    // a question somebody asks; one silently short is a dark stage.
    const doc = newPlot()
    await importPlotFile(doc, mvrFile(rig))
    const summary = await importPlotFile(doc, mvrFile(rig.slice(0, 2)))
    expect(snapshotPlot(doc).fixtures).toHaveLength(3)
    expect(summary).toContain('1 already here')
  })

  it('never claims a fixture somebody typed in by hand', async () => {
    // Hand-built fixtures carry no uuid, so nothing can match them — an
    // import that adopted one would overwrite work it did not create.
    const doc = newPlot()
    await importPlotFile(doc, new File(['Channel,Address\n201,300\n'], 'rig.csv'))
    await importPlotFile(doc, mvrFile(rig))
    const fixtures = snapshotPlot(doc).fixtures
    expect(fixtures).toHaveLength(4)
    expect(fixtures.find((f) => f.channel === '201')?.mvrUuid).toBeUndefined()
  })
})
