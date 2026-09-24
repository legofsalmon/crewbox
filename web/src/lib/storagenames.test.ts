// @vitest-environment happy-dom
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { plotStore } from '../modules/lighting/store/docManager.ts'
import { sheetStore } from '../modules/patch/store/docManager.ts'
import { screensStore } from '../modules/video/store/screensStore.ts'
import { DEVICE_PREF_KEYS, EVENT_PREF_KEYS } from './eventScope.ts'

/**
 * The names that reach phones in the field.
 *
 * `CLAUDE.md` says it plainly: IndexedDB database names, relay room names
 * and localStorage keys are derived from module ids, and renaming one
 * strands data on a device that is already carrying it. A crew chief's
 * sheets stop listing, an unsent incident is never filed, a phone signs
 * itself out — all silently, and only on the devices that had the old name,
 * which is every device that has ever run the app.
 *
 * Nothing pinned any of them. A rename was a one-word diff that passed lint,
 * typecheck and every test in the repo. This is the file that makes it a
 * conversation instead.
 *
 * If a test here fails, the question is not "what do I change it to". It is
 * "am I willing to strand what is on the phones already", and the answer is
 * usually a migration rather than a rename.
 */

// From the working directory rather than `import.meta.url`: under Vite the
// module URL is not a file URL, and this test reads the source on disk.
const SRC = ['src', 'web/src'].map((p) => join(process.cwd(), p)).find(existsSync) ?? ''

/** Every .ts/.tsx under web/src, so a new key cannot be added out of sight. */
function sources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(path))
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(readFileSync(path, 'utf8'))
    }
  }
  return out
}

it('found the source tree it is reading', () => {
  // Otherwise the key sweep below iterates nothing and passes.
  expect(SRC).not.toBe('')
  expect(sources(SRC).length).toBeGreaterThan(50)
})

describe('the relay rooms and document names', () => {
  it('is patch/sheet-<id>, which is where every sheet in the field lives', () => {
    expect(sheetStore.room('abc123')).toBe('patch/sheet-abc123')
    expect(sheetStore.docName('abc123')).toBe('sheet-abc123')
  })

  it('is lighting/plot-<id>', () => {
    expect(plotStore.room('abc123')).toBe('lighting/plot-abc123')
    expect(plotStore.docName('abc123')).toBe('plot-abc123')
  })

  it('is video/screens-<id>', () => {
    expect(screensStore.room('abc123')).toBe('video/screens-abc123')
    expect(screensStore.docName('abc123')).toBe('screens-abc123')
  })

  it('is the same for every event, because it is the box’s name and not the device’s', () => {
    // Each box is one event. A second event's sheets live under names of
    // their own on the phone, and in the same rooms on their own box.
    localStorage.setItem('crewbox:db-epoch', 'friday')
    expect(sheetStore.storageOf('saturday').database('abc123')).not.toBe(
      sheetStore.storageOf('friday').database('abc123')
    )
    expect(sheetStore.room('abc123')).toBe('patch/sheet-abc123')
    localStorage.clear()
  })

  it('gives each module one index, in its own namespace', () => {
    // The index is what makes a sheet appear in somebody else's selector.
    // Rename it and every device lists only what it made itself. `room()`
    // takes a doc *id*, so the index's own room is pinned at its source.
    expect(sheetStore.indexDocName).toBe('index')
    expect(plotStore.indexDocName).toBe('index')
    expect(screensStore.indexDocName).toBe('index')
    const store = readFileSync(join(SRC, 'lib/docs/store.ts'), 'utf8')
    expect(store).toContain("const INDEX_DOC_NAME = 'index'")
  })
})

describe('the browser storage names', () => {
  it('holds chat in a Dexie database called crewbox, with three tables', () => {
    // Read from the source rather than the instance: importing lib/db.ts
    // opens the database, and the name is what matters, not the handle. It
    // is `crewbox` for the first event a device held; eventScope.test.ts
    // pins what that name is for any other.
    const db = readFileSync(join(SRC, 'lib/db.ts'), 'utf8')
    expect(db).toContain("const DB_NAME = 'crewbox'")
    expect(db).toContain('storageNameFor(event, DB_NAME)')
    expect(db).toContain('new Dexie(chatDatabaseName(event))')
    expect(db).toContain("messages: 'id, [channelId+seq]'")
    expect(db).toContain("outbox: 'clientMsgId, createdAt'")
    expect(db).toContain("kv: 'key'")
  })

  it('derives a document database from the module id and nothing else', () => {
    const store = readFileSync(join(SRC, 'lib/docs/store.ts'), 'utf8')
    // The three names docs/MODULES.md promises, at their one definition.
    expect(store).toContain('const dbPrefix = `crewbox-${config.moduleId}-`')
    expect(store).toContain('config.registryKey ?? `crewbox:${config.moduleId}-docs`')
    expect(store).toContain('`${config.moduleId}/${docName}`')
  })

  it('keeps the first event’s documents where they always were, and a second event’s apart', () => {
    // The first event a device held is the one every phone in the field is
    // carrying: its names cannot move. Any other event's are its own.
    localStorage.setItem('crewbox:db-epoch', 'friday')
    const first = sheetStore.storageOf('friday')
    expect(first.database('abc123')).toBe('crewbox-patch-sheet-abc123')
    expect(first.indexDatabase).toBe('crewbox-patch-index')
    expect(first.registryKey).toBe('crewbox:patch-sheets')
    expect(plotStore.storageOf('friday').database('abc123')).toBe('crewbox-lighting-plot-abc123')
    expect(plotStore.storageOf('friday').registryKey).toBe('crewbox:lighting-docs')
    expect(screensStore.storageOf('friday').registryKey).toBe('crewbox:video-docs')

    const second = sheetStore.storageOf('saturday')
    expect(second.database('abc123')).toBe('crewbox@saturday-patch-sheet-abc123')
    expect(second.indexDatabase).toBe('crewbox@saturday-patch-index')
    expect(second.registryKey).toBe('crewbox@saturday:patch-sheets')
    localStorage.clear()
  })

  it('knows which keys are an event’s and which are the device’s', () => {
    // Forgetting the first event deletes its settings by name, because they
    // share today's names with the device's own. A key in neither list is
    // left behind when its event is forgotten; one in the wrong list takes a
    // device setting with it — the list of events, or where the box is.
    localStorage.setItem('crewbox:db-epoch', 'friday')
    const registries = [sheetStore, plotStore, screensStore].map(
      (store) => store.storageOf('friday').registryKey
    )
    localStorage.clear()
    const found = new Set<string>()
    for (const text of sources(SRC)) {
      for (const m of text.matchAll(/'(crewbox:[A-Za-z0-9:_-]+)'/g)) found.add(m[1])
    }
    expect(found.size).toBeGreaterThan(10)
    for (const key of found) {
      const events = EVENT_PREF_KEYS.includes(key) || registries.includes(key)
      expect(events !== DEVICE_PREF_KEYS.includes(key), key).toBe(true)
    }
  })

  it('keeps the patch registry under the key it shipped with', () => {
    // Sheets existed before the shared store did. The override is the whole
    // reason `registryKey` is a config field.
    const patch = readFileSync(join(SRC, 'modules/patch/store/docManager.ts'), 'utf8')
    expect(patch).toContain("registryKey: 'crewbox:patch-sheets'")
  })

  it('has exactly these localStorage keys and no others', () => {
    // A set, not a list of individual assertions, so this fails on a key
    // that was *added* without being thought about as well as one renamed.
    const found = new Set<string>()
    for (const text of sources(SRC)) {
      for (const m of text.matchAll(/'(crewbox[:-][A-Za-z0-9:_-]+)'/g)) found.add(m[1])
    }
    expect([...found].sort()).toEqual(
      [
        // Chat, identity and the shell.
        'crewbox:audio-in',
        'crewbox:audio-out',
        // Every event this device holds (the Boxes screen), and which one it
        // opens once there is more than one. Device-wide, like the theme.
        'crewbox:boxes',
        // Which event has the names in this list: the first one the device
        // held. See lib/eventScope.ts; every other event's are its own.
        'crewbox:db-epoch',
        'crewbox:event',
        'crewbox:event-name',
        // The iPhone app has asked iOS about the local network once, so its
        // search for boxes starts by itself from then on (lib/discovery.ts).
        'crewbox:find-boxes-asked',
        'crewbox:ios-tip-dismissed',
        'crewbox:lighting-seen',
        'crewbox:modules',
        'crewbox:patch-seen',
        'crewbox:patch-sheets',
        'crewbox:server-url',
        'crewbox:sounds',
        'crewbox:theme',
        'crewbox:token',
        // Which screen maps this device has opened (docs/SCREEN_MAPS.md); the
        // registry `crewbox:video-docs` is derived by the store and not a literal.
        'crewbox:video-screens-seen',
        'crewbox:wifi-ssid',
        // Not localStorage: an incident queue key, a notification tag, and the
        // timetable's own database and edit origin. Same rule applies — they
        // are on the device too.
        'crewbox-msg',
        // Nor this: what every statement a box signs starts with
        // (lib/identity.ts). Stored nowhere, and boxes in the field sign it,
        // so it can't change either.
        'crewbox-identity-v1',
        'crewbox-timetable-event',
        'crewbox-timetable-local',
        'crewbox:incident-outbox',
        'crewbox:incident-stage',
      ].sort()
    )
  })
})
