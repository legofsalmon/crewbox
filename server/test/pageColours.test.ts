import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { color } from '../../web/src/ds/tokens.js'
import { PAGE_CSS } from '../src/html.ts'

/**
 * The pages the box renders itself (/setup, /connect) take the shared
 * design system's roles, as the web app does, rather than colours of their
 * own. They used to carry the old navy and the brand amber as literals.
 */

const SRC = join(import.meta.dirname, '..', 'src')
const pages = ['html.ts', 'setup.ts', 'app.ts']

describe('the server-rendered pages', () => {
  it('carry both themes, following the device', () => {
    expect(PAGE_CSS).toContain(`--bg: ${color.dark.surface.ground}`)
    expect(PAGE_CSS).toContain('prefers-color-scheme: light')
    expect(PAGE_CSS).toContain(`--bg: ${color.light.surface.ground}`)
  })

  it('have no colour literals of their own', () => {
    // The QR's white is drawn from the palette in html.ts (content, not
    // chrome), so a literal hex in a page's CSS is always a role missed.
    const found: string[] = []
    for (const file of pages) {
      readFileSync(join(SRC, file), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/(?:color|background|border|outline)[^;{]*#[0-9a-f]{3,8}\b/i.test(line)) {
            found.push(`${file}:${i + 1}`)
          }
        })
    }
    expect(found).toEqual([])
  })
})
