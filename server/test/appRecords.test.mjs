import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The apps' copy of what the page keeps for each event (web/src/lib/appCopy.ts),
 * in files of the app's own that a wipe of the web view's storage leaves.
 *
 * None of this runs anywhere but a phone, and a copy nobody reads fails
 * silently: the page takes a missing plugin for an app too old to keep one,
 * and a wipe then signs the phone out, as it did before. So the wiring is
 * pinned here, as the sign-ins' is (appSignIns.test.mjs), and so are the
 * names, which reach phones.
 */

const read = (path) => readFileSync(join(import.meta.dirname, '..', '..', path), 'utf8')
const withoutComments = (code) => code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')

describe('the iPhone app’s copy', () => {
  const plugin = read('native/ios/App/App/RecordsPlugin.swift')
  const code = withoutComments(plugin)

  it('is registered on the bridge, built, and goes by the name the page looks for', () => {
    expect(read('native/ios/App/App/CrewboxViewController.swift')).toContain(
      'bridge?.registerPluginInstance(RecordsPlugin())'
    )
    expect(read('native/ios/App/App.xcodeproj/project.pbxproj')).toContain(
      '/* RecordsPlugin.swift in Sources */,'
    )
    expect(plugin).toContain('public let jsName = "CrewboxRecords"')
    expect(read('web/src/lib/server.ts')).toContain('Plugins?.CrewboxRecords')
  })

  it('is in Application Support, marked to stay out of backups, under a name that reaches phones', () => {
    // Not Caches, which iOS empties when it likes: this is what a wipe didn't take.
    expect(code).toContain('for: .applicationSupportDirectory')
    expect(code).not.toContain('.cachesDirectory')
    expect(code).toMatch(
      /values\.isExcludedFromBackup = true\s*try root\.setResourceValues\(values\)/
    )
    expect(plugin).toContain('static let folder = "crewbox-records"')
  })

  it('replaces each file whole', () => {
    expect(code).toMatch(/options: \[\.atomic, /)
  })
})

describe('the Android app’s copy', () => {
  const JAVA = 'native/android/app/src/main/java/com/colmhewson/crewbox'
  const records = withoutComments(read(`${JAVA}/Records.java`))

  it('is where backups and transfers to a new phone never go, under a name that reaches phones', () => {
    // Android leaves getNoBackupFilesDir() out of both, whatever the rules
    // say, so it needs no rule in data_extraction_rules.xml.
    expect(withoutComments(read(`${JAVA}/RecordsPlugin.java`))).toContain(
      'new File(getContext().getNoBackupFilesDir(), Records.FOLDER)'
    )
    expect(records).toContain('static final String FOLDER = "crewbox-records";')
  })
})

describe('the page’s side', () => {
  it('keeps each event’s record in a slot whose name reaches phones', () => {
    const copy = read('web/src/lib/appCopy.ts')
    expect(copy).toContain("const SLOT = 'event'")
    expect(copy).toContain("const COPIED = 'crewbox:copied-to-app'")
  })

  it('keeps each event’s unsent messages and show-log entries in slots whose names reach phones', () => {
    // Beside the record, in the event's folder (web/src/lib/unsent.ts). A new
    // name would strand, on every phone, whatever was waiting under the old.
    const unsent = read('web/src/lib/unsent.ts')
    expect(unsent).toContain("const MESSAGES_SLOT = 'outbox'")
    expect(unsent).toContain("const ENTRIES_SLOT = 'incident-outbox'")
  })

  it('keeps each event’s unconfirmed document edits in a slot whose name reaches phones', () => {
    // Beside the rest, in the event's folder (web/src/lib/docs/unsentEdits.ts).
    const edits = read('web/src/lib/docs/unsentEdits.ts')
    expect(edits).toContain("const EDITS_SLOT = 'doc-edits'")
  })
})
