import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { advertisedUrls, lanIps, printBoxBanner } from '../src/box.ts'
import { openDb } from '../src/db.ts'
import { Store } from '../src/store.ts'
import { attachWs, buildApp, mirrorOnLoopback, type App } from '../src/app.ts'

/**
 * A festival box sits on two networks: the crew Wi-Fi and the lighting VLAN.
 * These pin the two halves of CREWBOX_IFACE — which address gets advertised,
 * and that binding to the crew adapter still leaves localhost answering.
 */

type Interfaces = Parameters<typeof lanIps>[1]

/** A two-adapter machine: crew Wi-Fi and a lighting VLAN, plus loopback. */
const twoNics: Interfaces = {
  lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as never],
  // Deliberately enumerated lighting-first: the order the bug depends on.
  eth0: [{ address: '2.0.0.7', family: 'IPv4', internal: false } as never],
  wlan0: [{ address: '192.168.1.50', family: 'IPv4', internal: false } as never],
}

describe('which address the crew are pointed at', () => {
  it('pins the configured adapter to the front, keeping the rest visible', () => {
    // Without the preference this machine advertises the lighting VLAN
    // first, and the join QR is a poster of an address no phone can reach.
    expect(lanIps('', twoNics)).toEqual(['2.0.0.7', '192.168.1.50'])
    expect(lanIps('192.168.1.50', twoNics)).toEqual(['192.168.1.50', '2.0.0.7'])
  })

  it('ignores a preference no adapter has, rather than hiding real addresses', () => {
    // A pulled cable or a typo'd IP must not leave the box advertising
    // nothing. The readiness panel is what reports the mismatch.
    expect(lanIps('10.0.0.99', twoNics)).toEqual(['2.0.0.7', '192.168.1.50'])
  })

  it('never advertises link-local junk', () => {
    // 169.254.* means "cable but no DHCP" and has no business on a poster.
    const nics: Interfaces = {
      eth0: [{ address: '169.254.12.34', family: 'IPv4', internal: false } as never],
      wlan0: [{ address: '192.168.1.50', family: 'IPv4', internal: false } as never],
    }
    expect(lanIps('', nics)).toEqual(['192.168.1.50'])
  })

  it('skips IPv6 and loopback', () => {
    const nics: Interfaces = {
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as never],
      eth0: [
        { address: 'fe80::1', family: 'IPv6', internal: false } as never,
        { address: '10.1.2.3', family: 'IPv4', internal: false } as never,
      ],
    }
    expect(lanIps('', nics)).toEqual(['10.1.2.3'])
  })

  it('leads with the certificate name once TLS is on', () => {
    // Once a certificate is installed, localhost and raw-IP URLs all fail
    // the browser's name check — the box opened https://localhost on its own
    // screen and got the full "not private" interstitial. The cert's name is
    // the one address a browser trusts, so it goes first everywhere the box
    // speaks: banner, QR, auto-open, status file.
    const urls = advertisedUrls(8787, true, { hostname: 'chat.example.com' })
    expect(urls[0]).toBe('https://chat.example.com:8787')
    // The IP URLs stay visible behind it: the name only works once the
    // router's DNS override exists, and hiding working addresses behind an
    // unresolvable name strands the operator who hasn't set that up yet.
    expect(urls.slice(1)).toEqual(lanIps().map((ip) => `https://${ip}:8787`))
    // No certificate: exactly the old behaviour.
    expect(advertisedUrls(8787, false)).toEqual(lanIps().map((ip) => `http://${ip}:8787`))
  })

  it('banner and QR advertise the certificate name', () => {
    const lines: string[] = []
    const original = console.log
    console.log = (msg: string) => void lines.push(String(msg))
    try {
      printBoxBanner(8787, '1234', true, { hostname: 'chat.example.com' })
    } finally {
      console.log = original
    }
    const banner = lines.join('\n')
    expect(banner).toContain('https://chat.example.com:8787')
    // The name is the join URL — first, where the QR points — not an also-ran.
    const nameAt = banner.indexOf('https://chat.example.com:8787')
    for (const ip of lanIps()) {
      const ipAt = banner.indexOf(`https://${ip}:8787`)
      if (ipAt !== -1) expect(nameAt).toBeLessThan(ipAt)
    }
  })
})

describe('bound to one adapter, localhost still answers', () => {
  let app: App
  let db: DatabaseSync
  let filesDir: string
  let closeLoopback: (() => Promise<void>) | undefined

  beforeEach(() => {
    filesDir = mkdtempSync(pathJoin(tmpdir(), 'crewbox-net-'))
    db = openDb(pathJoin(filesDir, 'test.db'))
  })

  afterEach(async () => {
    await closeLoopback?.()
    closeLoopback = undefined
    await app.close()
    db.close()
    rmSync(filesDir, { recursive: true, force: true })
  })

  it('serves requests and websockets through the loopback mirror', async (ctx) => {
    // A real single-address bind: the machine's own LAN IP stands in for the
    // crew adapter. Needs one to exist — a fully offline runner skips.
    const [lanIp] = lanIps()
    if (!lanIp) ctx.skip()

    app = buildApp({
      store: new Store(db),
      eventPin: '9999',
      adminPassword: 'net-admin-pass',
      filesDir,
      dataDir: filesDir,
      logger: false,
    })
    await app.listen({ host: lanIp!, port: 0 })
    attachWs(app)
    const address = app.server.address()
    const port = typeof address === 'object' && address ? address.port : 0

    // The bind is real: the LAN address answers…
    const viaLan = await fetch(`http://${lanIp}:${port}/api/health`)
    expect(viaLan.ok).toBe(true)

    // …and localhost, being a different interface, does not.
    await expect(
      fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) })
    ).rejects.toThrow()

    // The mirror closes exactly that gap.
    closeLoopback = await mirrorOnLoopback(app, port)
    const viaLoopback = await fetch(`http://127.0.0.1:${port}/api/health`)
    expect(viaLoopback.ok).toBe(true)

    // Including upgrades — the chat socket is most of the product. A socket
    // that opens proves the upgrade path forwards; it closing shortly after
    // (no valid token) is the server's business, not the mirror's.
    const opened = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      const timer = setTimeout(() => resolve(false), 3000)
      ws.once('open', () => {
        clearTimeout(timer)
        ws.close()
        resolve(true)
      })
      ws.once('error', () => {
        clearTimeout(timer)
        resolve(false)
      })
    })
    expect(opened).toBe(true)
  }, 15_000)
})
