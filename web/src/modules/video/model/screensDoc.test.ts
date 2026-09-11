// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import fixture from './__fixtures__/screen-setup.xml?raw'
import { parseScreenSetup } from './screenSetup.ts'
import {
  initScreensDoc,
  replaceSetup,
  setFeed,
  setScreensTitle,
  snapshotScreens,
} from './screensDoc.ts'

const newDoc = () => {
  const doc = new Y.Doc()
  initScreensDoc(doc, {
    title: 'Main stage',
    setup: parseScreenSetup(fixture),
    sourceFile: 'mainstage-v01.xml',
    by: 'Colm',
  })
  return doc
}

/** Exchange updates both ways, as the relay would. */
const sync = (a: Y.Doc, b: Y.Doc) => {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)))
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)))
}

describe('screens doc', () => {
  it('initialises with the setup and who brought it', () => {
    const snap = snapshotScreens(newDoc())
    expect(snap.meta).toMatchObject({
      title: 'Main stage',
      sourceFile: 'mainstage-v01.xml',
      importedBy: 'Colm',
    })
    expect(snap.meta.importedAt).not.toBe('')
    expect(snap.setup?.screens.map((s) => s.name)).toEqual(['LED', 'Side'])
    expect(snap.feeds).toEqual({})
  })

  it('is empty, not broken, before anything has arrived', () => {
    const snap = snapshotScreens(new Y.Doc())
    expect(snap.setup).toBeNull()
    expect(snap.meta.title).toBe('')
  })

  it('replaces the setup without losing the feeds or the title', () => {
    const doc = newDoc()
    setFeed(doc, 'LED', { processorId: 'p1', inputId: 'hdmi1' })
    setScreensTitle(doc, 'Main stage (Friday)')

    const next = parseScreenSetup(fixture)
    next.name = 'mainstage-v02'
    replaceSetup(doc, next, { sourceFile: 'mainstage-v02.xml', by: 'Sam' })

    const snap = snapshotScreens(doc)
    expect(snap.setup?.name).toBe('mainstage-v02')
    expect(snap.meta).toMatchObject({
      title: 'Main stage (Friday)',
      sourceFile: 'mainstage-v02.xml',
      importedBy: 'Colm',
      updatedBy: 'Sam',
    })
    expect(snap.feeds).toEqual({ LED: { processorId: 'p1', inputId: 'hdmi1' } })
  })

  it('clears a feed with null', () => {
    const doc = newDoc()
    setFeed(doc, 'LED', { processorId: 'p1', inputId: 'hdmi1' })
    setFeed(doc, 'LED', null)
    expect(snapshotScreens(doc).feeds).toEqual({})
  })

  it('merges feeds set on two devices while apart', () => {
    const desk = newDoc()
    const phone = new Y.Doc()
    sync(desk, phone)

    setFeed(desk, 'LED', { processorId: 'p1', inputId: 'hdmi1' })
    setFeed(phone, 'Side', { processorId: 'p2', inputId: 'sdi1' })
    sync(desk, phone)

    expect(snapshotScreens(desk).feeds).toEqual(snapshotScreens(phone).feeds)
    expect(Object.keys(snapshotScreens(phone).feeds).sort()).toEqual(['LED', 'Side'])
  })
})
