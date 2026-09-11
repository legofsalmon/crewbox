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

/**
 * The two things a relay makes the doc responsible for: not growing without
 * bound, and not trusting what comes back.
 */
describe('screens doc, against the relay', () => {
  it('does not write the same setup twice', () => {
    // Arena rewrites Preferences/AdvancedOutput.xml on any preference change,
    // so the file watcher offers the same parsed setup over and over. Every
    // Y.Map write keeps the superseded value in the update log, and the relay
    // stops syncing a room that passes MAX_ROOM_BYTES — silently, while the
    // pane still says it is watching.
    const doc = newDoc()
    const setup = parseScreenSetup(fixture)
    const imported = Y.encodeStateAsUpdate(doc).byteLength

    // Twenty saves of a file whose screen setup did not change.
    for (let i = 0; i < 20; i++) {
      expect(replaceSetup(doc, setup, { sourceFile: 'prefs.xml', by: 'Colm' })).toBe(false)
    }
    expect(Y.encodeStateAsUpdate(doc).byteLength).toBe(imported)

    // And one where it did, so the guard is not simply refusing everything.
    const changed = { ...setup, comp: { w: 3840, h: 2160 } }
    expect(replaceSetup(doc, changed, { sourceFile: 'prefs.xml', by: 'Colm' })).toBe(true)
    expect(Y.encodeStateAsUpdate(doc).byteLength).toBeGreaterThan(imported)
  })

  it('still writes a setup that really changed, and says when it did', () => {
    const doc = newDoc()
    const setup = parseScreenSetup(fixture)
    replaceSetup(doc, setup, { sourceFile: 'a.xml', by: 'Colm' })
    const changed = { ...setup, screens: setup.screens.slice(0, 1) }
    expect(replaceSetup(doc, changed, { sourceFile: 'b.xml', by: 'Ash' })).toBe(true)
    const snap = snapshotScreens(doc)
    expect(snap.setup?.screens).toHaveLength(1)
    expect(snap.meta.sourceFile).toBe('b.xml')
    expect(snap.meta.updatedBy).toBe('Ash')
  })

  it('refuses a setup a peer wrote that the builders would throw on', () => {
    // There is no error boundary in this app: a throw during render unmounts
    // the whole tree, so a malformed setup from another device would cost a
    // crew member their chat and anything unsent, not just the map. These are
    // the shapes buildView and meshBoundary index without checking.
    const setup = parseScreenSetup(fixture)
    const cases: Record<string, unknown> = {
      'a screen with no layers': {
        ...setup,
        screens: [{ ...setup.screens[0], layers: undefined }],
      },
      'a layer that is not an object': {
        ...setup,
        screens: [{ ...setup.screens[0], layers: [null] }],
      },
      'a warp whose vertex count does not match its grid': {
        ...setup,
        screens: [
          {
            ...setup.screens[0],
            layers: [
              {
                ...setup.screens[0]!.layers[0],
                warp: { mode: 'PM_LINEAR', cols: 3, rows: 3, verts: [{ x: 0, y: 0 }] },
              },
            ],
          },
        ],
      },
      'no composition size': { ...setup, comp: {} },
    }
    for (const [what, value] of Object.entries(cases)) {
      const doc = new Y.Doc()
      doc.getMap('setup').set('json', value)
      expect(snapshotScreens(doc).setup, what).toBeNull()
    }
  })

  it('accepts a setup carrying a field this build has never heard of', () => {
    // The other half of that: a newer build adding a key must not blank the
    // map on an older one.
    const doc = new Y.Doc()
    doc.getMap('setup').set('json', { ...parseScreenSetup(fixture), somethingNew: 42 })
    expect(snapshotScreens(doc).setup).not.toBeNull()
  })

  it('lets a map be renamed, and merges two people doing it', () => {
    const a = newDoc()
    const b = new Y.Doc()
    sync(a, b)
    setScreensTitle(a, 'Upstage wall')
    sync(a, b)
    expect(snapshotScreens(b).meta.title).toBe('Upstage wall')
  })
})
