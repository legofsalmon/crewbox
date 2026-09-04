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
import { createServer, type Server } from 'node:http'
import {
  LIVEKIT_PORT,
  livekitConfigYaml,
  livekitCredentials,
  probeSfu,
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

/**
 * A stub that behaves like the real SFU as far as the supervisor can tell:
 * it listens on the SFU port and answers 200 to /rtc/validate. The probe's
 * own token semantics are unit-tested directly against in-process servers;
 * here the stub only has to *pass* the probe, since a bare TCP listener no
 * longer counts as a running SFU — that was the whole bug.
 */
const listenerStub = (): Buffer =>
  Buffer.from(
    `#!/usr/bin/env node\n` +
      `require('node:http').createServer((req, res) => {\n` +
      `  res.statusCode = req.url.startsWith('/rtc/validate') ? 200 : 404\n` +
      `  res.end('success')\n` +
      `}).listen(${LIVEKIT_PORT}, '0.0.0.0')\n` +
      `process.on('SIGTERM', () => process.exit(0))\n`
  )

/** A stub that starts and stays alive without ever binding the port. */
const loiterStub = (): Buffer =>
  Buffer.from(
    `#!/usr/bin/env node\n` +
      `setInterval(() => {}, 1000)\n` +
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

    const { sfu } = await spawnLiveKit(
      binPath,
      configPath,
      { key: 'key', secret: 'secret' },
      silentLog
    )
    expect(sfu).not.toBeNull()
    running.push(sfu!)
    expect(sfu).toMatchObject({ port: LIVEKIT_PORT, key: 'key', secret: 'secret' })
  }, 15_000)

  it('stops what it started, freeing the port', async () => {
    const dataDir = tempDir()
    const { binPath, configPath } = unpackLiveKit(dataDir, listenerStub(), 'k', 's')

    const first = await spawnLiveKit(binPath, configPath, { key: 'k', secret: 's' }, silentLog)
    expect(first.sfu).not.toBeNull()
    await first.sfu!.stop()

    // A leaked SFU would hold the port and the next boot would silently lose
    // voice, so proving the port comes back is the point of this test.
    const second = await spawnLiveKit(binPath, configPath, { key: 'k', secret: 's' }, silentLog)
    expect(second.sfu).not.toBeNull()
    running.push(second.sfu!)
  }, 20_000)

  it('gives up quietly when the SFU dies instead of listening', async () => {
    const dataDir = tempDir()
    const { binPath, configPath } = unpackLiveKit(dataDir, crasherStub(), 'k', 's')
    const warnings: string[] = []

    const { sfu, failure } = await spawnLiveKit(
      binPath,
      configPath,
      { key: 'k', secret: 's' },
      {
        info: () => {},
        warn: (msg) => warnings.push(msg),
      }
    )

    // Null, not a throw: a box whose voice won't start is still a box.
    expect(sfu).toBeNull()
    expect(failure).toBe('no-start')
    expect(warnings.join(' ')).toMatch(/SFU/)
  }, 20_000)

  it('gives up quietly when the binary will not run at all', async () => {
    const dataDir = tempDir()
    const { configPath } = unpackLiveKit(dataDir, listenerStub(), 'k', 's')

    const { sfu, failure } = await spawnLiveKit(
      join(dataDir, 'does-not-exist'),
      configPath,
      { key: 'k', secret: 's' },
      silentLog
    )
    expect(sfu).toBeNull()
    expect(failure).toBe('no-start')
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
    const { sfu } = await spawnLiveKit(binPath, configPath, { key: 'k', secret: 's' }, silentLog)
    expect(sfu).not.toBeNull()
    running.push(sfu!)

    const pid = Number(readFileSync(join(dir, 'livekit', 'livekit.pid'), 'utf8'))
    expect(Number.isInteger(pid)).toBe(true)
    // Signal 0 proves the recorded pid is the process actually running.
    expect(() => process.kill(pid, 0)).not.toThrow()
  }, 15_000)

  it('clears the record when the SFU stops cleanly', async () => {
    const dir = tempDir()
    const { binPath, configPath } = unpackLiveKit(dir, listenerStub(), 'k', 's')
    const { sfu } = await spawnLiveKit(binPath, configPath, { key: 'k', secret: 's' }, silentLog)
    await sfu!.stop()
    // A stale file would make the next boot kill an unrelated process that
    // happened to inherit the number.
    await new Promise((r) => setTimeout(r, 300))
    expect(existsSync(join(dir, 'livekit', 'livekit.pid'))).toBe(false)
  }, 15_000)

  it('kills an orphan it finds, and frees the port', async () => {
    const dir = tempDir()
    const { binPath, configPath } = unpackLiveKit(dir, listenerStub(), 'k', 's')
    const orphan = (await spawnLiveKit(binPath, configPath, { key: 'k', secret: 's' }, silentLog))
      .sfu
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

  it('will not kill an SFU another running box still owns', async () => {
    // Mid-update this is the supervisor's SFU. Reaping it meant a box that
    // rolled back went on minting tokens for a process it had killed, and
    // every voice join failed until somebody restarted the box by hand.
    const dir = tempDir()
    const { binPath, configPath } = unpackLiveKit(dir, listenerStub(), 'k', 's')
    const owned = (await spawnLiveKit(binPath, configPath, { key: 'k', secret: 's' }, silentLog))
      .sfu
    expect(owned).not.toBeNull()
    const pid = Number(readFileSync(join(dir, 'livekit', 'livekit.pid'), 'utf8'))

    const warnings: string[] = []
    const reaped = await reapOrphanLiveKit(
      join(dir, 'livekit'),
      { info: () => {}, warn: (m) => warnings.push(m) },
      process.pid
    )
    expect(reaped).toBe(false)
    expect(warnings.join(' ')).toMatch(/still has it/)
    // Still there, which is the whole point.
    expect(() => process.kill(pid, 0)).not.toThrow()
    await owned!.stop()
  }, 15_000)

  it('throws away a pid file that says nothing', async () => {
    // What a write that ran out of disk leaves behind. Left in place it made
    // every future start skip the reap, so an orphan would hold :7880 for
    // good.
    const dir = tempDir()
    mkdirSync(join(dir, 'livekit'), { recursive: true })
    writeFileSync(join(dir, 'livekit', 'livekit.pid'), '')
    expect(await reapOrphanLiveKit(join(dir, 'livekit'), silentLog)).toBe(false)
    expect(existsSync(join(dir, 'livekit', 'livekit.pid'))).toBe(false)
  })

  it('throws away a pid file that is junk', async () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'livekit'), { recursive: true })
    writeFileSync(join(dir, 'livekit', 'livekit.pid'), 'not a number')
    expect(await reapOrphanLiveKit(join(dir, 'livekit'), silentLog)).toBe(false)
    expect(existsSync(join(dir, 'livekit', 'livekit.pid'))).toBe(false)
  })

  it('still tidies a dead record even with a box running', async () => {
    // What the update path actually leaves behind: it stops its own SFU
    // before launching the new box, so the file names a pid that has gone.
    const dir = tempDir()
    mkdirSync(join(dir, 'livekit'), { recursive: true })
    writeFileSync(join(dir, 'livekit', 'livekit.pid'), '2147483646')
    expect(await reapOrphanLiveKit(join(dir, 'livekit'), silentLog, process.pid)).toBe(false)
    expect(existsSync(join(dir, 'livekit', 'livekit.pid'))).toBe(false)
  })
})

describe('probing whatever holds the SFU port', () => {
  /**
   * The check `waitForPort` cannot make. That helper proves something is
   * listening; a stray livekit-server from an old test session proved for a
   * full day that "something" is not the same as "ours" — it held 7880 with
   * different keys, the box's own SFU died of EADDRINUSE, and voice read as
   * configured everywhere while every join was rejected.
   */
  const servers: Server[] = []
  const serve = (status: number): Promise<number> =>
    new Promise((resolve) => {
      const server = createServer((req, res) => {
        res.statusCode = req.url?.startsWith('/rtc/validate') ? status : 404
        res.end(status === 200 ? 'success' : 'invalid token')
      })
      servers.push(server)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resolve(typeof address === 'object' && address ? address.port : 0)
      })
    })

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('says ok when the listener validates the token', async () => {
    const port = await serve(200)
    expect(await probeSfu(port, 'k', 'ssssssssssssssssssssssssssssssss')).toBe('ok')
  })

  it('says rejected when the listener refuses it', async () => {
    // A real LiveKit holding someone else's keys answers exactly this way.
    const port = await serve(401)
    expect(await probeSfu(port, 'k', 'ssssssssssssssssssssssssssssssss')).toBe('rejected')
  })

  it('says rejected for a listener that is not an SFU at all', async () => {
    // Anything HTTP that is not answering /rtc/validate with 200 — a dev
    // server, a proxy — is equally unusable for voice.
    const port = await serve(503)
    expect(await probeSfu(port, 'k', 'ssssssssssssssssssssssssssssssss')).toBe('rejected')
  })

  it('says unreachable when nothing is listening', async () => {
    const port = await serve(200)
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()))
    expect(await probeSfu(port, 'k', 'ssssssssssssssssssssssssssssssss')).toBe('unreachable')
  })
})

describe('a stranger on the SFU port', () => {
  it('refuses to claim a listener that rejects its tokens', async () => {
    // The race the probe closes: the stranger is listening, so waitForPort
    // reports up immediately — possibly before this box's own SFU has had
    // time to die of EADDRINUSE. The loiter stub pins that window open: the
    // child is alive and never binds, exactly the state the old code saw
    // when it declared voice running.
    const stranger = createServer((req, res) => {
      res.statusCode = 401
      res.end('invalid token')
    })
    await new Promise<void>((resolve) => stranger.listen(LIVEKIT_PORT, '0.0.0.0', resolve))

    try {
      const dir = tempDir()
      const { binPath, configPath } = unpackLiveKit(dir, loiterStub(), 'k', 's')
      const warnings: string[] = []
      const { sfu, failure } = await spawnLiveKit(
        binPath,
        configPath,
        { key: 'k', secret: 's' },
        { info: () => {}, warn: (m) => warnings.push(m) }
      )

      expect(sfu).toBeNull()
      expect(failure).toBe('port-held')
      // The log has to hand someone the command, because at this point the
      // squatter is invisible to everything except the operating system.
      expect(warnings.join(' ')).toContain('lsof')
    } finally {
      await new Promise<void>((resolve) => stranger.close(() => resolve()))
    }
  }, 20_000)

  it('names the held port when its own SFU dies of the collision', async () => {
    // Same stranger, but the child exits quickly — the EADDRINUSE shape a
    // real livekit-server produces. Whichever side of the race the timing
    // lands on, the verdict must come out port-held, not success.
    const stranger = createServer((req, res) => {
      res.statusCode = 401
      res.end('invalid token')
    })
    await new Promise<void>((resolve) => stranger.listen(LIVEKIT_PORT, '0.0.0.0', resolve))

    try {
      const dir = tempDir()
      const { binPath, configPath } = unpackLiveKit(dir, crasherStub(), 'k', 's')
      const { sfu, failure } = await spawnLiveKit(
        binPath,
        configPath,
        { key: 'k', secret: 's' },
        silentLog
      )
      expect(sfu).toBeNull()
      expect(failure).toBe('port-held')
    } finally {
      await new Promise<void>((resolve) => stranger.close(() => resolve()))
    }
  }, 20_000)
})

describe('binding the SFU to the crew adapter', () => {
  it('binds signalling to loopback plus the crew adapter when one is pinned', () => {
    // The whole point of CREWBOX_IFACE is that a box on a lighting VLAN
    // answers nothing there. The SFU's signalling was the last thing still
    // bound to every adapter. Loopback stays, because the box's own proxy
    // and health probe reach the SFU at 127.0.0.1.
    const yaml = livekitConfigYaml('k', 's', '192.168.1.50')
    expect(yaml).toContain('bind_addresses: ["127.0.0.1", "192.168.1.50"]')
    expect(yaml).not.toContain('0.0.0.0')
  })

  it('keeps binding everywhere when no adapter is pinned', () => {
    expect(livekitConfigYaml('k', 's')).toContain('bind_addresses: ["0.0.0.0"]')
  })

  it('writes the pinned adapter into the unpacked config', () => {
    const dataDir = tempDir()
    const { configPath } = unpackLiveKit(dataDir, listenerStub(), 'k', 's', '192.168.1.50')
    expect(readFileSync(configPath, 'utf8')).toContain('"192.168.1.50"')
  })
})

/**
 * The one boot-time write with nothing under it.
 *
 * `unpackLiveKit` is guarded, so a build that cannot write its SFU leaves
 * voice off and the box starts. The pid write after the spawn was not — and
 * it is the one that fails first on a full disk, because it is always a new
 * file. Unguarded it threw out of `main()` and exited 1 with the SFU already
 * running, so the child outlived the box and held :7880 for good.
 */
describe('when the pid file cannot be written', () => {
  it('leaves voice off and takes the child with it, rather than exiting', async () => {
    const dir = tempDir()
    const { binPath, configPath } = unpackLiveKit(dir, listenerStub(), 'k', 's')
    // A directory where the pid file wants to be: EISDIR, from the same line
    // as ENOSPC.
    mkdirSync(join(dir, 'livekit', 'livekit.pid'), { recursive: true })

    const warnings: string[] = []
    const outcome = await spawnLiveKit(
      binPath,
      configPath,
      { key: 'k', secret: 's' },
      { info: () => {}, warn: (m) => warnings.push(m) }
    )
    expect(outcome).toEqual({ sfu: null, failure: 'no-start' })
    expect(warnings.join(' ')).toMatch(/could not record the SFU's pid/)

    // And nothing is left holding the port. Proved by binding it.
    await new Promise((r) => setTimeout(r, 300))
    const probe = createServer()
    const bound = await new Promise<boolean>((resolve) => {
      probe.once('error', () => resolve(false))
      probe.listen(LIVEKIT_PORT, '127.0.0.1', () => resolve(true))
    })
    await new Promise<void>((r) => probe.close(() => r()))
    expect(bound, 'an orphaned SFU is still holding the port').toBe(true)
  }, 20_000)
})
