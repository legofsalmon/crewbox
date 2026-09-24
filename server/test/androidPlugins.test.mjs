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
      'CrewboxVoice',
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
