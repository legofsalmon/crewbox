import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The shared design system, as crewbox takes it.
 *
 * web/src/ds/ holds only what the design system's scripts/sync.mjs vendored.
 * Whether a copy is *behind* the design system needs a checkout of that
 * private repository beside this one (`npm run ds:check`); whether it was
 * edited here, or is read wrongly, does not, so these hold that half.
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
  it('holds tokens.css, tokens.js and tokens.d.ts', () => {
    expect(readdirSync(DS).sort()).toEqual(['tokens.css', 'tokens.d.ts', 'tokens.js'])
  })

  for (const file of ['tokens.css', 'tokens.d.ts', 'tokens.js']) {
    it(`${file} is unedited since it was vendored`, () => {
      // A hand edit here is a fix the design-system repo should get; the next
      // `npm run ds:sync` would refuse to run over it.
      const text = readFileSync(join(DS, file), 'utf8')
      const newline = text.indexOf('\n')
      const stamp = /@letissier\/design-system \S+ · (\S+) · sha256-([0-9a-f]{16}) · /.exec(
        text.slice(0, newline)
      )
      expect(stamp?.[1]).toBe(file)
      const sum = createHash('sha256')
        .update(text.slice(newline + 1))
        .digest('hex')
        .slice(0, 16)
      expect(sum).toBe(stamp?.[2])
    })
  }

  it('defines every --ds- role the app reads', () => {
    // A misspelt role computes to nothing, silently: no colour at all.
    const css = readFileSync(join(DS, 'tokens.css'), 'utf8')
    const defined = new Set([...css.matchAll(/^\s*(--ds-[a-z0-9-]+)\s*:/gm)].map((m) => m[1]))
    const unknown: string[] = []
    for (const file of sources(SRC)) {
      for (const m of readFileSync(file, 'utf8').matchAll(/var\((--ds-[a-z0-9-]+)/g)) {
        if (!defined.has(m[1])) unknown.push(`${relative(SRC, file)}: ${m[1]}`)
      }
    }
    expect(unknown).toEqual([])
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
