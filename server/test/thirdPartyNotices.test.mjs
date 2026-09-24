import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OUTPUT, renderNotices, shippedPackages } from '../../scripts/third-party-notices.mjs'

/**
 * The licence notices that ship in the web build, and so in every box, app
 * and APK. Every permissive licence Crewbox depends on asks for its notice
 * to go with the copies; this is what makes sure it does, and that it keeps
 * doing so after a dependency changes.
 */

const ROOT = join(import.meta.dirname, '..', '..')
const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'))
const shipped = shippedPackages(lock)
const names = new Set(shipped.map((p) => p.name))

describe('third-party notices', () => {
  it('match the lockfile (run node scripts/third-party-notices.mjs if not)', () => {
    expect(readFileSync(OUTPUT, 'utf8') === renderNotices(lock)).toBe(true)
  })

  it('cover every runtime dependency of the server and the web app', () => {
    for (const ws of ['server', 'web']) {
      const deps = Object.keys(lock.packages[ws]?.dependencies ?? {}).filter(
        (n) => !n.startsWith('@crewbox/')
      )
      expect(deps.length).toBeGreaterThan(0)
      for (const dep of deps) expect(names, `${ws} → ${dep}`).toContain(dep)
    }
  })

  it('cover the Capacitor runtime and the Workbox code the PWA build copies in', () => {
    for (const dep of [
      '@capacitor/core',
      '@capacitor/android',
      'workbox-window',
      'workbox-routing',
    ])
      expect(names).toContain(dep)
  })

  it('leave out build tools', () => {
    for (const dep of ['vite', 'typescript', 'vitest', 'esbuild', '@playwright/test'])
      expect(names).not.toContain(dep)
  })

  it('contain no copyleft licence; one needs a decision before it ships', () => {
    const copyleft = shipped.filter(({ info }) =>
      /\b(A|L)?GPL|MPL|EPL|CDDL|SSPL/i.test(info.license ?? '')
    )
    expect(copyleft.map((p) => `${p.name} (${p.info.license})`)).toEqual([])
  })
})
