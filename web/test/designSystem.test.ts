import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The shared design system, as crewbox takes it.
 *
 * web/src/ds/ holds only what the design system's scripts/sync.mjs vendored,
 * with the design system's own checker among it. Whether a copy is *behind*
 * the published system is `npm run ds:check`, which warns; whether it was
 * edited here, or is read wrongly, fails these.
 */

const SRC = join(import.meta.dirname, '..', 'src')
const DS = join(SRC, 'ds')

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (path === DS) continue
    if (statSync(path).isDirectory()) yield* sources(path)
    else if (/\.(s?css|tsx?)$/.test(name)) yield path
  }
}

describe('the vendored design system', () => {
  it('holds tokens.css, tokens.js, tokens.d.ts and the checker', () => {
    expect(readdirSync(DS).sort()).toEqual([
      'ds-check.mjs',
      'tokens.css',
      'tokens.d.ts',
      'tokens.js',
    ])
  })

  it('is unedited since it was vendored, and defines every --ds- role the app reads', () => {
    // A hand edit here is a fix the design-system repo should get, and the
    // next `npm run ds:sync` would drop it; a misspelt role computes to
    // nothing, silently. The design system's checker holds both.
    const run = spawnSync(
      process.execPath,
      [join(DS, 'ds-check.mjs'), 'web/src/ds', '--reads', 'web/src', '--offline'],
      { cwd: join(SRC, '..', '..'), encoding: 'utf8', env: { PATH: process.env.PATH } }
    )
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
  })

  it('keeps the brand amber to the brand', () => {
    // Amber means attention (--warn). The studio's amber is --brand: the
    // logo and the splash glow, and nothing that means something.
    const amber = /#f5b73e|#986400|245,\s*183,\s*62/i
    const found: string[] = []
    for (const file of sources(SRC)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (amber.test(line) && !/^\s*--brand:/.test(line)) {
            found.push(`${relative(SRC, file)}:${i + 1}`)
          }
        })
    }
    expect(found).toEqual([])
  })
})
