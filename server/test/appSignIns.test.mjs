import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Where the apps keep a crew member's sign-ins (web/src/lib/sessions.ts):
 * with the app, in the iPhone's Keychain and sealed by Android's Keystore,
 * and never in what a backup takes to another phone.
 *
 * None of this runs anywhere but a phone. A Keychain item that syncs, or a
 * backup rule naming a file that isn't the one written, builds and installs
 * and works on the phone it was made on, and then signs a new phone in as
 * the old one. So it is pinned here, as the plugins' wiring is.
 */

const read = (path) => readFileSync(join(import.meta.dirname, '..', '..', path), 'utf8')
const ANDROID = 'native/android/app/src/main'
const JAVA = `${ANDROID}/java/com/colmhewson/crewbox`
const withoutComments = (xml) => xml.replace(/<!--[\s\S]*?-->/g, '')

describe('the iPhone app’s sign-ins', () => {
  const plugin = read('native/ios/App/App/SessionsPlugin.swift')

  it('are registered on the bridge, built, and go by the name the page looks for', () => {
    expect(read('native/ios/App/App/CrewboxViewController.swift')).toContain(
      'bridge?.registerPluginInstance(SessionsPlugin())'
    )
    expect(read('native/ios/App/App.xcodeproj/project.pbxproj')).toContain(
      '/* SessionsPlugin.swift in Sources */,'
    )
    expect(plugin).toContain('public let jsName = "CrewboxSessions"')
    expect(read('web/src/lib/server.ts')).toContain('Plugins?.CrewboxSessions')
  })

  it('stay on this iPhone: never synced, never restored to another', () => {
    const code = plugin.replace(/\/\/.*$/gm, '')
    expect(code).toContain('kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly')
    expect(code).not.toMatch(/kSecAttrAccessible(?!AfterFirstUnlockThisDeviceOnly)\w/)
    expect(code).not.toContain('kSecAttrSynchronizable')
    // Each is changed in place, never deleted first, so a write that fails
    // loses nothing. One added new gets the accessibility above, and a change
    // leaves it as it was.
    const save = /@objc func save[\s\S]*?\n {4}\}\n/.exec(code)?.[0] ?? ''
    expect(save).toMatch(
      /SecItemUpdate\(\s*item as CFDictionary, \[kSecValueData as String: data\] as CFDictionary\)/
    )
    expect(save).toMatch(
      /if status == errSecItemNotFound \{\s*var added = item[\s\S]*?kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly\s*status = SecItemAdd\(added as CFDictionary, nil\)/
    )
    expect(save).not.toContain('SecItemDelete')
  })

  it('are under a Keychain service that reaches phones, so it keeps its name', () => {
    expect(plugin).toContain('static let service = "com.colmhewson.crewbox.sessions"')
  })
})

describe('the Android app’s sign-ins', () => {
  const sessions = read(`${JAVA}/Sessions.java`)
  const service = read(`${JAVA}/AlertsService.java`)

  it('are sealed in a file and by a key whose names reach phones, so they keep them', () => {
    expect(sessions).toContain('static final String PREFS = "crewbox-sessions";')
    expect(sessions).toContain('static final String KEY_ALIAS = "crewbox-sessions";')
    expect(sessions).toContain('KeyStore.getInstance(KEYSTORE)')
    expect(sessions).toContain('private static final String KEYSTORE = "AndroidKeyStore";')
  })

  it('are sealed with a key a locked phone can use, for the alerts service in a pocket', () => {
    // Either of these would have the service's restart find no token while
    // the phone is locked, and stop alerting for the rest of the shift.
    expect(sessions).not.toContain('setUserAuthenticationRequired')
    expect(sessions).not.toContain('setUnlockedDeviceRequired')
  })

  it('are what the alerts service reads when Android restarts it, and it keeps only the name', () => {
    expect(service).toContain('private static final String PREFS = "crewbox-alerts";')
    expect(service).toMatch(/session = prefs\.getString\(PREF_SESSION, ""\);/)
    expect(service).toMatch(/Sessions\.get\(this, session\)/)
    expect(service).toMatch(/session = stringExtra\(intent, EXTRA_SESSION\);/)
    expect(service).toMatch(/\.putString\(PREF_SESSION, session\)/)
    // The token itself is never written there again, only removed.
    expect(service).not.toMatch(/putString\(PREF_(?:OLD_)?TOKEN/)
    expect(service.match(/\.remove\(PREF_OLD_TOKEN\)/g)).toHaveLength(2)
    expect(read(`${JAVA}/AlertsPlugin.java`)).toMatch(
      /String session = call\.getString\("session", ""\);[\s\S]*AlertsService\.start\(getContext\(\), serverUrl, token, session, myName\);/
    )
    // And the page names it (web/src/store.ts).
    expect(read('web/src/store.ts')).toContain('session: storageName(TOKEN_KEY)')
  })

  it('are waited for, not forgotten, when the Keystore doesn’t answer', () => {
    // Forgetting the sign-in on a Keystore that didn't answer left alerts
    // off until somebody opened the app. Sessions says which it was
    // (KeystoreCalls, with JVM tests), and the service waits on the one.
    expect(sessions).toMatch(
      /static synchronized String get\(Context context, String name\) throws KeystoreCalls\.NotNow \{/
    )
    // Each Keystore call there is asked twice, a key is thrown away only
    // when Android says it is gone, and before Android 12 a key said to be
    // missing, with sign-ins sealed under it, is waited out too.
    expect(sessions).toContain('KeystoreCalls.retried(call, Sessions::keyGone, Sessions::pause)')
    const sealing = sessions.split('\n').filter((line) => /SessionSeal\.(open|seal)\(/.test(line))
    expect(sealing).toHaveLength(3)
    for (const line of sealing) expect(line).toMatch(/ask\(\(\) -> SessionSeal\.(open|seal)\(/)
    expect(
      sessions.match(
        /missingMayBeOutOfReach\(Build\.VERSION\.SDK_INT\)\) \{\s*throw new KeystoreCalls\.NotNow/g
      )
    ).toHaveLength(2)
    const waits = [...service.matchAll(/catch \(KeystoreCalls\.NotNow e\) \{([\s\S]*?)\n\s*\}/g)]
    expect(waits).toHaveLength(2)
    for (const [, body] of waits) {
      expect(body).not.toContain('forgetCredentials')
      expect(body).toMatch(/waitForToken\(\);|handler\.postDelayed\(readAgain, retryMs\);/)
    }
    // A start cancels a read still waiting, and nothing connects without a
    // token: the box would refuse the hello, and the service forget the
    // sign-in it was waiting for.
    expect(service).toMatch(/onStartCommand[\s\S]*?handler\.removeCallbacks\(readAgain\);/)
    expect(service).toMatch(
      /private void connect\(\) \{[^}]*if \(stopped \|\| serverUrl\.isEmpty\(\) \|\| token\.isEmpty\(\)\) return;/
    )
  })

  describe('left out of backups and transfers to a new phone', () => {
    const manifest = withoutComments(read(`${ANDROID}/AndroidManifest.xml`))
    const application = /<application\b[^>]*>/.exec(manifest)?.[0] ?? ''
    const excluded = [
      'crewbox-sessions.xml', // Sessions.PREFS
      'crewbox-alerts.xml', // AlertsService.PREFS
    ]

    it('by rules the manifest names, for Android 12 and later and for 11 and older', () => {
      expect(application).toContain('android:dataExtractionRules="@xml/data_extraction_rules"')
      expect(application).toContain('android:fullBackupContent="@xml/backup_rules"')
      expect(application).toContain('android:allowBackup="true"')
    })

    it('in the cloud and from phone to phone, on Android 12 and later', () => {
      const rules = withoutComments(read(`${ANDROID}/res/xml/data_extraction_rules.xml`))
      for (const section of ['cloud-backup', 'device-transfer']) {
        const body = new RegExp(`<${section}>([\\s\\S]*?)</${section}>`).exec(rules)?.[1] ?? ''
        expect(excludes(body), section).toEqual(excluded)
        // An include would turn the section into a list of what goes, and
        // leave out the page's storage, which a new phone should have.
        expect(body, section).not.toContain('<include')
      }
    })

    it('on Android 11 and older', () => {
      const rules = withoutComments(read(`${ANDROID}/res/xml/backup_rules.xml`))
      expect(excludes(rules)).toEqual(excluded)
      expect(rules).not.toContain('<include')
    })

    it('naming the files the app writes them to', () => {
      // A rule naming a file that isn't there excludes nothing, silently.
      expect(sessions).toContain(`PREFS = "${excluded[0].replace('.xml', '')}"`)
      expect(service).toContain(`PREFS = "${excluded[1].replace('.xml', '')}"`)
    })
  })
})

/** The shared-preferences files a set of backup rules leaves out. */
function excludes(rules) {
  return [...rules.matchAll(/<exclude\s+domain="sharedpref"\s+path="([^"]+)"\s*\/>/g)].map(
    (match) => match[1]
  )
}
