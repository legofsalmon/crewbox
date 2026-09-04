import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every source path the documentation points at, checked to exist.
 *
 * Docs go stale the way this one did: `docs/MODULES.md` told the next person
 * to import `inRunningOrder` from `shell/timetable/agenda.ts`, which had
 * moved into the shared package — so the one file written to explain how to
 * add a module sent them to a file that is not there. Nothing catches that,
 * because prose does not compile.
 *
 * Only paths with a directory in them. A bare `hooks.ts` inside a table
 * scoped to one directory is a name, not a path, and demanding it resolve
 * would make this test noise rather than a guard.
 */

const ROOT = ['.', '..']
  .map((p) => join(process.cwd(), p))
  .find((p) => existsSync(join(p, 'docs')))!

/** Where a repo-relative path might legitimately be rooted. */
const ROOTS = ['', 'web/src/', 'server/src/', 'shared/src/', 'web/', 'server/']

/**
 * Paths that deliberately do not resolve, each for a stated reason. Anything
 * not on this list has to exist — that is the whole point.
 */
const ELSEWHERE = new Map([
  // docs/UNIFICATION_PLAN.md is a record of the three repositories this one
  // was merged from, and names files as they were in those.
  ['src/model/sheetDoc.ts', 'the pre-merge livepatch repo'],
  ['src/store/sync.ts', 'the pre-merge livepatch repo'],
  ['src/store/docManager.ts', 'the pre-merge livepatch repo'],
  ['scripts/build-sea.mjs', 'the pre-merge livepatch repo'],
  ['server/index.cjs', 'the pre-merge livepatch repo'],
  // docs/VIDEO_MONITORING.md credits a separate project's source.
  ['docs/read-only-monitoring.md', 'the novasun project, not this repo'],
  ['src/novasun/snmp.py', 'the novasun project, not this repo'],
])

const PATH_IN_BACKTICKS =
  /`([a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+\.(?:ts|tsx|mjs|js|sh|swift|cs|java|md|yml|yaml|json|css|scss|plist|xml))`/g

function markdown(dir: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...markdown(path))
    else if (entry.name.endsWith('.md')) out.push({ file: path, text: readFileSync(path, 'utf8') })
  }
  return out
}

describe('the paths the documentation points at', () => {
  const docs = [
    ...markdown(join(ROOT, 'docs')),
    ...markdown(join(ROOT, 'site', 'docs-src')),
    { file: 'README.md', text: readFileSync(join(ROOT, 'README.md'), 'utf8') },
    { file: 'CLAUDE.md', text: readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8') },
  ]

  it('has documentation to check', () => {
    expect(docs.length).toBeGreaterThan(20)
  })

  it('all exist', () => {
    const dead: string[] = []
    for (const { file, text } of docs) {
      for (const [, path] of text.matchAll(PATH_IN_BACKTICKS)) {
        if (ELSEWHERE.has(path)) continue
        if (!ROOTS.some((base) => existsSync(join(ROOT, base + path)))) {
          dead.push(`${file}: ${path}`)
        }
      }
    }
    expect(dead).toEqual([])
  })

  it('is checking enough paths to mean something', () => {
    // A regex that stopped matching would make the test above pass on an
    // empty list, which is the failure mode of every guard like this.
    const found = new Set<string>()
    for (const { text } of docs) {
      for (const [, path] of text.matchAll(PATH_IN_BACKTICKS)) found.add(path)
    }
    expect(found.size).toBeGreaterThan(40)
    expect(found).toContain('shared/src/timetable.ts')
  })
})
