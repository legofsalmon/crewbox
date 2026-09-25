import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The Android app's own plugins, and the activity that has to register them.
 *
 * Capacitor finds the plugins that come from npm packages by itself, but a
 * plugin in the app's own source is there for the page only if MainActivity
 * registers it before the bridge starts. One that is not builds, installs and
 * runs, and its `window.Capacitor.Plugins` entry is simply missing, which the
 * page reads as a browser: no save, no voice prompt, no search for boxes, and
 * nothing anywhere saying why.
 */

const SRC = join(
  import.meta.dirname,
  '..',
  '..',
  'native/android/app/src/main/java/com/colmhewson/crewbox'
)

const plugins = readdirSync(SRC)
  .filter((file) => file.endsWith('.java'))
  .flatMap((file) => {
    const text = readFileSync(join(SRC, file), 'utf8')
    const name = /@CapacitorPlugin\(\s*(?:name\s*=\s*)?"([^"]+)"/.exec(text)?.[1]
    const cls = /public class (\w+) extends Plugin\b/.exec(text)?.[1]
    return name && cls ? [{ name, cls }] : []
  })

describe('the Android app’s own plugins', () => {
  it('are found here, so the check below is checking something', () => {
    expect(plugins.map((plugin) => plugin.name).sort()).toEqual([
      'CrewboxAlerts',
      'CrewboxDiscovery',
      'CrewboxFiles',
      'CrewboxNetwork',
      'CrewboxRecords',
      'CrewboxScanner',
      'CrewboxSessions',
      'CrewboxVoice',
      'CrewboxWifi',
    ])
  })

  it('are each registered by MainActivity, before the bridge starts', () => {
    const activity = readFileSync(join(SRC, 'MainActivity.java'), 'utf8')
    const start = activity.indexOf('super.onCreate(')
    expect(start).toBeGreaterThan(0)
    for (const { cls } of plugins) {
      const at = activity.indexOf(`registerPlugin(${cls}.class);`)
      expect(at, `${cls} is not registered`).toBeGreaterThan(0)
      expect(at, `${cls} is registered after the bridge has started`).toBeLessThan(start)
    }
  })

  it('go by the names the page looks for', () => {
    // web/src/lib/server.ts reads each one off window.Capacitor.Plugins.
    const server = readFileSync(
      join(import.meta.dirname, '..', '..', 'web/src/lib/server.ts'),
      'utf8'
    )
    for (const { name } of plugins) {
      expect(server, name).toContain(`Plugins?.${name}`)
    }
  })
})

/**
 * The app's hold on the crew Wi-Fi (SiteWifi), which keeps its traffic for
 * the box on a Wi-Fi with no internet when mobile data is on. Where it
 * starts, and what it hears, is wiring only a phone would otherwise show.
 */
describe('the app’s hold on the crew Wi-Fi', () => {
  const read = (file) => readFileSync(join(SRC, file), 'utf8')

  it('starts before the page loads, so its first request to the box goes over the Wi-Fi', () => {
    const activity = read('MainActivity.java')
    const at = activity.indexOf('SiteWifi.get(this).start(')
    expect(at).toBeGreaterThan(0)
    expect(at).toBeLessThan(activity.indexOf('super.onCreate('))
  })

  it('starts in the alerts service too, which Android restarts without a page, before it connects', () => {
    expect(read('AlertsService.java')).toMatch(
      /siteWifi\.start\(serverUrl\);\s*siteWifi\.whenSettled\(onWifi -> handler\.post\(this::connect\)\);/
    )
  })

  it('hears when the app starts searching the Wi-Fi for boxes, and each way it stops', () => {
    const discovery = read('DiscoveryPlugin.java')
    expect(discovery.match(/SiteWifi\.get\(getContext\(\)\)\.searching\(true\)/g)).toHaveLength(1)
    // Asked to stop, and a new page, which wants no search until it says so.
    expect(discovery.match(/SiteWifi\.get\(getContext\(\)\)\.searching\(false\)/g)).toHaveLength(2)
  })

  it('tells whoever hears it each time the app’s traffic moves, and only then', () => {
    const siteWifi = read('SiteWifi.java')
    expect(siteWifi).toMatch(
      /if \(connectivity\.bindProcessToNetwork\(network\)\) \{\s*bound = network;\s*for \(Runnable moved : hearing\) moved\.run\(\);/
    )
    expect(siteWifi.match(/moved\.run\(\)/g)).toHaveLength(1)
  })

  it('has the page try again at once when the traffic moves, as a browser does when its network comes back', () => {
    const plugin = read('NetworkPlugin.java')
    expect(plugin).toMatch(/moved = \(\) -> getBridge\(\)\.triggerWindowJSEvent\("online"\)/)
    expect(plugin).toMatch(
      /public void load\(\) \{\s*SiteWifi\.get\(getContext\(\)\)\.hear\(moved\);/
    )
    expect(plugin).toMatch(
      /void handleOnDestroy\(\) \{\s*SiteWifi\.get\(getContext\(\)\)\.stopHearing\(moved\);/
    )
  })

  it('has the alerts service try again at once when the traffic moves, unless its socket works', () => {
    const service = read('AlertsService.java')
    expect(service).toMatch(
      /moved = \(\) -> handler\.post\(\(\) -> \{\s*if \(stopped \|\| welcomed\) return;\s*retryMs = RETRY_MS;\s*connect\(\);/
    )
    expect(service).toMatch(/createChannels\(\);\s*SiteWifi\.get\(this\)\.hear\(moved\);/)
    expect(service).toMatch(
      /public void onDestroy\(\) \{\s*SiteWifi\.get\(this\)\.stopHearing\(moved\);/
    )
    // Working means welcomed, and only on this socket: every new attempt,
    // and every failure, starts it over.
    expect(service.match(/^\s+welcomed = false;$/gm)).toHaveLength(2)
    expect(service).toMatch(/retryMs = RETRY_MS;\s*welcomed = true;/)
  })
})
