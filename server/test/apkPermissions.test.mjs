import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ALLOWED_EXTRA,
  REQUIRED,
  findAapt,
  permissionsIn,
  verdict,
} from '../../scripts/check-apk-permissions.mjs'

/**
 * What the sideloaded APK asks a phone for.
 *
 * The manifest is not the shipped answer — Gradle merges it with every
 * library's before it becomes an APK, so a permission can go missing from
 * one and arrive from the other with nothing in this repo changing. Both
 * directions have consequences that only show up on somebody else's phone:
 * voice was dead in the native app for an entire release because
 * RECORD_AUDIO was undeclared (the OS denies an undeclared permission with
 * no prompt, so there was nothing to see), and this APK is installed off a
 * QR code in a tent, where a surprise permission on the install screen is a
 * crew member deciding not to trust it.
 */

const dump = (...lines) => ['package: com.colmhewson.crewbox', ...lines].join('\n')

describe('reading a permission dump', () => {
  it("reads aapt2's shape", () => {
    expect(
      permissionsIn(
        dump(
          "uses-permission: name='android.permission.INTERNET'",
          "uses-permission: name='android.permission.RECORD_AUDIO'"
        )
      )
    ).toEqual(['android.permission.INTERNET', 'android.permission.RECORD_AUDIO'])
  })

  it('survives the variations build-tools has printed over the years', () => {
    // Being strict here would mean a build-tools bump reporting an APK with
    // no permissions at all — which reads as "everything is missing" on a
    // good build, and would train whoever sees it to ignore this check.
    const found = permissionsIn(
      dump(
        "uses-permission: name='android.permission.INTERNET'",
        "uses-permission: name='android.permission.CAMERA' maxSdkVersion='32'",
        "uses-permission-sdk-23: name='android.permission.RECORD_AUDIO'",
        "optional-permission: name='android.permission.NFC'",
        "uses-permission:'android.permission.VIBRATE'",
        'uses-permission: android.permission.WAKE_LOCK'
      )
    )
    expect(found).toContain('android.permission.CAMERA')
    expect(found).toContain('android.permission.RECORD_AUDIO')
    expect(found).toContain('android.permission.VIBRATE')
    expect(found).toContain('android.permission.WAKE_LOCK')
  })

  it('ignores the rest of the dump', () => {
    // `permission:` declares one, which is not the same as asking for it.
    expect(
      permissionsIn(
        dump(
          "permission: name='com.colmhewson.crewbox.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION'",
          "uses-permission: name='android.permission.INTERNET'"
        )
      )
    ).toEqual(['android.permission.INTERNET'])
  })
})

describe('judging what the APK holds', () => {
  it('passes an APK holding exactly what was asked for', () => {
    expect(verdict([...REQUIRED, ...ALLOWED_EXTRA].sort())).toEqual({
      missing: [],
      unexpected: [],
    })
  })

  it('names a permission that went missing', () => {
    // The original failure: the app installs, runs, and silently cannot do
    // the one thing that permission was for.
    const held = REQUIRED.filter((name) => name !== 'android.permission.RECORD_AUDIO')
    expect(verdict(held).missing).toEqual(['android.permission.RECORD_AUDIO'])
  })

  it('names one a library brought with it', () => {
    const held = [...REQUIRED, 'android.permission.ACCESS_FINE_LOCATION']
    expect(verdict(held).unexpected).toEqual(['android.permission.ACCESS_FINE_LOCATION'])
  })

  it('passes the real APK, which carries one the build writes itself', () => {
    // Exactly what the debug APK asked for on CI. The last one is the
    // manifest merger's: signature-level, scoped to this app's own package,
    // not shown on an install screen, and not in our manifest to declare.
    // Without an allowance for it, every build fails this check — and a
    // check that fails on every green build teaches people to ignore it.
    const built = [
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
      'android.permission.INTERNET',
      'android.permission.MODIFY_AUDIO_SETTINGS',
      'android.permission.POST_NOTIFICATIONS',
      'android.permission.RECORD_AUDIO',
      'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
      'com.colmhewson.crewbox.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION',
    ]
    expect(verdict(built)).toEqual({ missing: [], unexpected: [] })
  })

  it('allows that one under any application id, and nothing else like it', () => {
    // The name is built from the application id, so a rename or a flavour
    // must not start failing builds.
    expect(
      verdict([...REQUIRED, 'com.example.debug.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION'])
        .unexpected
    ).toEqual([])
    // But it is a specific permission, not a licence for the suffix.
    expect(
      verdict([...REQUIRED, 'com.colmhewson.crewbox.DYNAMIC_RECEIVER_EXPORTED_PERMISSION'])
        .unexpected
    ).toEqual(['com.colmhewson.crewbox.DYNAMIC_RECEIVER_EXPORTED_PERMISSION'])
  })

  it('is not satisfied by an empty dump', () => {
    // If the tool changed its output and nothing parsed, the answer must be
    // "everything is missing" rather than "nothing is wrong".
    expect(verdict([]).missing).toEqual(REQUIRED)
  })
})

describe('finding the tool on the runner', () => {
  const home = '/opt/android'
  const at = (...paths) => {
    const held = new Set(paths)
    return { list: () => ['33.0.1', '35.0.0', '34.0.0'], exists: (p) => held.has(p) }
  }

  it('takes the newest build-tools, not the first listed', () => {
    // The runner image carries several, and the oldest can predate the APK's
    // compile SDK — which fails with a parse error rather than a clear one.
    expect(
      findAapt(
        home,
        at('/opt/android/build-tools/35.0.0/aapt2', '/opt/android/build-tools/33.0.1/aapt2')
      )
    ).toBe('/opt/android/build-tools/35.0.0/aapt2')
  })

  it('falls back to aapt where aapt2 is absent', () => {
    expect(findAapt(home, at('/opt/android/build-tools/35.0.0/aapt'))).toBe(
      '/opt/android/build-tools/35.0.0/aapt'
    )
  })

  it('says so rather than guessing when there is no SDK', () => {
    expect(findAapt('', at())).toBeNull()
    expect(
      findAapt(home, {
        list: () => {
          throw new Error('ENOENT')
        },
        exists: () => false,
      })
    ).toBeNull()
  })
})

describe('the list and the manifest', () => {
  it('are the same set, so neither can drift from the other', () => {
    // The manifest stays the source of truth — this is what makes deleting a
    // line from it a failure here rather than a discovery in a field.
    const manifest = readFileSync(
      join(import.meta.dirname, '..', '..', 'native/android/app/src/main/AndroidManifest.xml'),
      'utf8'
    )
    const declared = [...manifest.matchAll(/<uses-permission\s+android:name="([\w.]+)"/g)].map(
      (m) => m[1]
    )
    expect(declared.length).toBeGreaterThan(0)
    expect([...declared].sort()).toEqual([...REQUIRED, ...ALLOWED_EXTRA].sort())
  })
})
