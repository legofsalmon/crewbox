import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The crewbox://join link, as each app claims it.
 *
 * The page reads `crewbox://join?server=…&pin=…` (web/src/lib/joinCode.ts),
 * and a phone hands one only to an app that has claimed the scheme. Nothing
 * in a build checks the claim: an Info.plist or a manifest that loses it
 * still builds and installs, and the link then does nothing at all. So both
 * are pinned here, beside the permission checks.
 */

const ROOT = join(import.meta.dirname, '..', '..')
/** A file of the repo, its comments taken out: they name keys, and are not them. */
const read = (path) => readFileSync(join(ROOT, path), 'utf8').replace(/<!--[\s\S]*?-->/g, '')

describe('the iPhone app', () => {
  const plist = read('native/ios/App/App/Info.plist')

  it('claims the crewbox scheme, and no other', () => {
    const lists = [
      ...plist.matchAll(/<key>CFBundleURLSchemes<\/key>\s*<array>([\s\S]*?)<\/array>/g),
    ]
    expect(lists).toHaveLength(1)
    const schemes = [...lists[0][1].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1])
    expect(schemes).toEqual(['crewbox'])
    // Inside the URL types, where iOS looks for it.
    expect(plist).toMatch(
      /<key>CFBundleURLTypes<\/key>\s*<array>\s*<dict>[\s\S]*CFBundleURLSchemes/
    )
  })

  it('hands a link to Capacitor, which gives it to the page', () => {
    // Without this the App plugin never hears of a link, and the app opens at
    // whatever it last showed. Under the scene life cycle (Apple's TN3187,
    // which Xcode 27 is to require) iOS gives links to the scene delegate,
    // not the app delegate, so the scene delegate passes each to Capacitor:
    // a running app's at once, and one that started the app once the
    // bridge's view has appeared, when the plugins can hear it.
    expect(plist).toMatch(/UIApplicationSceneManifest/)
    expect(plist).toMatch(/\$\(PRODUCT_MODULE_NAME\)\.SceneDelegate/)
    const scene = readFileSync(join(ROOT, 'native/ios/App/App/SceneDelegate.swift'), 'utf8')
    expect(scene).toMatch(/func scene\(_ scene: UIScene, openURLContexts URLContexts/)
    expect(scene).toMatch(/connectionOptions\.urlContexts[\s\S]*\.capacitorViewDidAppear/)
    expect(scene).toContain(
      'ApplicationDelegateProxy.shared.application(\n            UIApplication.shared, open: context.url, options: options)'
    )
    const project = readFileSync(join(ROOT, 'native/ios/App/App.xcodeproj/project.pbxproj'), 'utf8')
    expect(project).toMatch(/SceneDelegate\.swift in Sources \*\/,/)
  })
})

describe('the Android app', () => {
  const manifest = read('native/android/app/src/main/AndroidManifest.xml')
  const activity = /<activity\b[^>]*android:name="\.MainActivity"[^>]*>([\s\S]*?)<\/activity>/.exec(
    manifest
  )

  it('opens crewbox://join links in the main activity, from a browser or a message', () => {
    expect(activity).not.toBeNull()
    const filters = [...activity[1].matchAll(/<intent-filter>([\s\S]*?)<\/intent-filter>/g)].map(
      (m) => m[1]
    )
    const link = filters.find((filter) => filter.includes('android:scheme="crewbox"'))
    expect(link).toBeDefined()
    expect(link).toContain('<action android:name="android.intent.action.VIEW" />')
    expect(link).toContain('<category android:name="android.intent.category.DEFAULT" />')
    // Without BROWSABLE a browser or a messaging app cannot open it.
    expect(link).toContain('<category android:name="android.intent.category.BROWSABLE" />')
    expect(link).toContain('<data android:scheme="crewbox" android:host="join" />')
  })

  it('hands a link to the app that is running, rather than starting a second one', () => {
    expect(activity[0]).toMatch(/android:launchMode="singleTask"/)
  })

  it('forgets a link when Android reopens the app from Recents, before Capacitor reads it', () => {
    // Capacitor reads the starting intent's link in super.onCreate, so after
    // it the link has already gone to the page.
    const source = readFileSync(
      join(ROOT, 'native/android/app/src/main/java/com/colmhewson/crewbox/MainActivity.java'),
      'utf8'
    )
    const onCreate = /void onCreate\(Bundle savedInstanceState\) \{([\s\S]*?)\n {2}\}/.exec(
      source
    )?.[1]
    expect(onCreate).toBeDefined()
    const forget = onCreate.indexOf('forgetLinkFromRecents(getIntent());')
    expect(forget).toBeGreaterThan(-1)
    expect(forget).toBeLessThan(onCreate.indexOf('super.onCreate(savedInstanceState);'))
    expect(source).toMatch(
      /FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY\) != 0\) \{\s*intent\.setData\(null\);/
    )
  })

  it('is the app a phone’s join page names, so Chrome knows whether it is there', () => {
    // web/src/lib/joinCode.ts builds Chrome's intent: link with the package
    // in it. A different one is an app Chrome never finds, and every phone,
    // with the app or without, is sent to the fallback page.
    const gradle = readFileSync(join(ROOT, 'native/android/app/build.gradle'), 'utf8')
    const id = /applicationId\s+"([^"]+)"/.exec(gradle)?.[1]
    expect(id).toBeDefined()
    const web = readFileSync(join(ROOT, 'web/src/lib/joinCode.ts'), 'utf8')
    expect(web).toContain(`const ANDROID_PACKAGE = '${id}'`)
  })
})
