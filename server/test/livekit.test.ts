import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LIVEKIT_PORT,
  livekitConfigYaml,
  livekitCredentials,
  reapOrphanLiveKit,
  spawnLiveKit,
  unpackLiveKit,
  type EmbeddedLiveKit,
} from '../src/livekit.ts'

/**
 * The real SFU only exists in a release build, so these run against stub
 * binaries. What's under test is the supervisor: does it unpack and mark
 * executable, does it wait for the thing to actually listen, does it give up
 * cleanly when it doesn't, and does it stop what it started. That logic is
 * what decides whether a crew has voice on site.
 */

const dirs: string[] = []
const running: EmbeddedLiveKit[] = []

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'crewbox-lk-'))
  dirs.push(dir)
  return dir
}

/** A stub that listens on the SFU port, as the real one would. */
const listenerStub = (): Buffer =>
  Buffer.from(
    `#!/usr/bin/env node\n` +
      `require('node:net').createServer().listen(${LIVEKIT_PORT}, '0.0.0.0')\n` +
      `process.on('SIGTERM', () => process.exit(0))\n`
  )

/** A stub that starts and dies, as a broken SFU would. */
const crasherStub = (): Buffer =>
  Buffer.from(`#!/usr/bin/env node\nprocess.stderr.write('boom\\n')\nprocess.exit(3)\n`)

const silentLog = { info: () => {}, warn: () => {} }

afterEach(async () => {
  for (const handle of running.splice(0)) await handle.stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('livekit credentials', () => {
  it('generates once and reuses them afterwards', () => {
    // Tokens minted before a restart have to stay valid after it.
    const settings = new Map<string, string>()
    const get = (k: string) => settings.get(k)
    const set = (k: string, v: string) => void settings.set(k, v)

    const first = livekitCredentials(get, set)
    const second = livekitCredentials(get, set)

    expect(first.key).toMatch(/^box[0-9a-f]{12}$/)
    expect(first.secret.length).toBeGreaterThan(30)
    expect(second).toEqual(first)
  })
})

describe('livekit config', () => {
  it('pins a single UDP port and keeps external IP lookup off', () => {
    const yaml = livekitConfigYaml('k', 's')
    // A range would mean thousands of holes in a venue firewall; external IP
    // lookup would stall startup on a LAN with no uplink.
    expect(yaml).toContain('udp_port: 7882')
    expect(yaml).not.toContain('port_range')
    expect(yaml).toContain('use_external_ip: false')
    expect(yaml).toContain('  k: s')
  })
})

describe('unpacking', () => {
  it('writes the binary executable next to its config', () => {
    const dataDir = tempDir()
    const { binPath, configPath } = unpackLiveKit(dataDir, listenerStub(), 'key', 'secret')

    expect(readFileSync(configPath, 'utf8')).toContain('  key: secret')
    // Without the exec bit the spawn fails with EACCES on every Unix box.
    expect(statSync(binPath).mode & 0o111).toBeGreaterThan(0)
  })
})

describe('supervisor', () => {
  it('starts an SFU and reports it running', async () => {
    const dataDir = tempDir()
    const { binPath, configPath } = unpackLiveKit(dataDir, listenerStub(), 'key', 'secret')

    const handle = await spawnLiveKit(
      binPath,
      configPath,
      { key: 'key', secret: 'secret' },
      silentLog
    )
    expect(handle).not.toBeNull()
    running.push(handle!)
    expect(handle).toMatchObject({ port: LIVEKIT_PORT, key: 'key', secret: 'secret' })
  }, 15_000)

  it('stops what it started, freeing the port', async () => {
    const dataDir = tempDir()
    const { binPath, configPath } = unpackLiveKit(dataDir, listenerStub(), 'k', 's')

    const first = await spawnLiveKit(binPath, configPath, { key: 'k', secret: 's' }, silentLog)
    expect(first).not.toBeNull()
    await first!.stop()

    // A leaked SFU would hold the port and the next boot would silently lose
    // voice, so proving the port comes back is the point of this test.
    const second = await spawnLiveKit(binPath, configPath, { key: 'k', secret: 's' }, silentLog)
    expect(second).not.toBeNull()
    running.push(second!)
  }, 20_000)

  it('gives up quietly when the SFU dies instead of listening', async () => {
    const dataDir = tempDir()
    const { binPath, configPath } = unpackLiveKit(dataDir, crasherStub(), 'k', 's')
    const warnings: string[] = []

    const handle = await spawnLiveKit(
      binPath,
      configPath,
      { key: 'k', secret: 's' },
      {
        info: () => {},
        warn: (msg) => warnings.push(msg),
      }
    )

    // Null, not a throw: a box whose voice won't start is still a box.
    expect(handle).toBeNull()
    expect(warnings.join(' ')).toMatch(/SFU/)
  }, 20_000)

  it('gives up quietly when the binary will not run at all', async () => {
    const dataDir = tempDir()
    const { configPath } = unpackLiveKit(dataDir, listenerStub(), 'k', 's')

    const handle = await spawnLiveKit(
      join(dataDir, 'does-not-exist'),
      configPath,
      { key: 'k', secret: 's' },
      silentLog
    )
    expect(handle).toBeNull()
  }, 20_000)
})

describe('orphaned SFU from a killed box', () => {
  /**
   * Being force-quit is a supported way to stop a box — the store is SQLite
   * in WAL mode and the product assumes hard power cuts — but that path skips
   * the shutdown handler, so the SFU keeps holding the port. The next box
   * then spawns one that dies of EADDRINUSE while the orphan answers with the
   * previous run's keys, which reads as working voice that nobody can talk on.
   */
  it('records the running SFU so a later boot can find it', async () => {
    const dir = tempDir()
    const { binPath, configPath } = unpackLiveKit(dir, listenerStub(), 'k', 's')
    const handle = await spawnLiveKit(binPath, configPath, { key: 'k', secret: 's' }, silentLog)
    expect(handle).not.toBeNull()
    running.push(handle!)

    const pid = Number(readFileSync(join(dir, 'livekit', 'livekit.pid'), 'utf8'))
    expect(Number.isInteger(pid)).toBe(true)
    // Signal 0 proves the recorded pid is the process actually running.
    expect(() => process.kill(pid, 0)).not.toThrow()
  }, 15_000)

  it('clears the record when the SFU stops cleanly', async () => {
    const dir = tempDir()
    const { binPath, configPath } = unpackLiveKit(dir, listenerStub(), 'k', 's')
    const handle = await spawnLiveKit(binPath, configPath, { key: 'k', secret: 's' }, silentLog)
    await handle!.stop()
    // A stale file would make the next boot kill an unrelated process that
    // happened to inherit the number.
    await new Promise((r) => setTimeout(r, 300))
    expect(existsSync(join(dir, 'livekit', 'livekit.pid'))).toBe(false)
  }, 15_000)

  it('kills an orphan it finds, and frees the port', async () => {
    const dir = tempDir()
    const { binPath, configPath } = unpackLiveKit(dir, listenerStub(), 'k', 's')
    const orphan = await spawnLiveKit(binPath, configPath, { key: 'k', secret: 's' }, silentLog)
    expect(orphan).not.toBeNull()
    const pid = Number(readFileSync(join(dir, 'livekit', 'livekit.pid'), 'utf8'))

    // The box goes away without running its shutdown handler; the SFU lives.
    const warnings: string[] = []
    const reaped = await reapOrphanLiveKit(join(dir, 'livekit'), {
      info: () => {},
      warn: (m) => warnings.push(m),
    })
    expect(reaped).toBe(true)
    expect(warnings.join(' ')).toMatch(/previous run/)

    // reapOrphanLiveKit waits for the process to actually go, so this holds
    // immediately — no sleep, which would hide a reap that returned early.
    expect(() => process.kill(pid, 0)).toThrow()
  }, 15_000)

  it('says nothing when there is no orphan to reap', async () => {
    const dir = tempDir()
    expect(await reapOrphanLiveKit(dir, silentLog)).toBe(false)
  })

  it('ignores a stale record whose process is long gone', async () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'livekit'), { recursive: true })
    // A pid that cannot be running: the file outlived a reboot.
    writeFileSync(join(dir, 'livekit', 'livekit.pid'), '2147483646')
    expect(await reapOrphanLiveKit(join(dir, 'livekit'), silentLog)).toBe(false)
    expect(existsSync(join(dir, 'livekit', 'livekit.pid'))).toBe(false)
  })
})
