import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * The real entry point, killed the way a power cut kills it.
 *
 * The unit tests in reports.test.ts prove the marker and the queue; this
 * proves index.ts wires them: that a box which died without shutting down is
 * noticed on the next start and queued as a crash waiting for an admin's
 * answer, and that a box stopped properly is not.
 */

const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url))
const SERVER = fileURLToPath(new URL('..', import.meta.url))

const children: ChildProcess[] = []
const dirs: string[] = []

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.pid === undefined) continue
    try {
      // The whole group: npx -> tsx -> node. See wsAbuse.test.ts.
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const markers = (dir: string): string[] =>
  readdirSync(dir).filter((name) => name.startsWith('running-'))

async function until<T>(what: string, check: () => T | undefined, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = check()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** Start a box from source on a free port; resolve with the pid in its marker. */
async function startBox(dataDir: string): Promise<number> {
  const before = new Set(markers(dataDir))
  const child = spawn('npx', ['tsx', ENTRY], {
    cwd: SERVER,
    stdio: 'ignore',
    detached: true,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      CREWBOX_PORT: '0',
      EVENT_PIN: '4321',
      ADMIN_PASSWORD: 'a-long-test-password',
      WEB_DIST: join(dataDir, 'no-web'),
      CREWBOX_UPDATE_CHECK: '0',
      CREWBOX_CAPTIVE: '0',
      LIVEKIT_URL: 'ws://127.0.0.1:1',
    },
  })
  children.push(child)
  const name = await until('the box to write its run marker', () =>
    markers(dataDir).find((m) => !before.has(m))
  )
  return Number(name.slice('running-'.length, -'.json'.length))
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('a box that died without shutting down', () => {
  it('is noticed on the next start and waits for an admin to say send', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'crewbox-crash-'))
    dirs.push(dataDir)

    const first = await startBox(dataDir)
    process.kill(first, 'SIGKILL')
    await until('the first box to die', () => (alive(first) ? undefined : true))

    const second = await startBox(dataDir)
    const report = await until('a queued report', () => {
      const files = (() => {
        try {
          return readdirSync(join(dataDir, 'reports')).filter((f) => f.endsWith('.json'))
        } catch {
          return []
        }
      })()
      return files.length ? files : undefined
    })
    expect(report).toHaveLength(1)
    const queued = JSON.parse(readFileSync(join(dataDir, 'reports', report[0]), 'utf8'))
    expect(queued).toMatchObject({
      endpoint: 'crash',
      consent: 'pending',
      payload: { product: 'crewbox', kind: 'unclean-exit' },
    })
    // The dead box's marker is gone; the live one's is there.
    expect(markers(dataDir)).toEqual([`running-${second}.json`])

    // Stopped properly, it leaves nothing behind to be mistaken for a crash.
    process.kill(second, 'SIGTERM')
    await until('the second box to stop', () => (alive(second) ? undefined : true))
    expect(markers(dataDir)).toEqual([])
  }, 90_000)
})
