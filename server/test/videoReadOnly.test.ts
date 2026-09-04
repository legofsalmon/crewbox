import { readFileSync, readdirSync } from 'node:fs'
import { createServer, type Server as HttpServer } from 'node:http'
import { createServer as netServer, type Server as NetServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { COEX_HTTP_PORT, REGISTER_BUS_PORT } from '@crewbox/shared'
import { realWatcherIo } from '../src/video/watcher.ts'

/**
 * crewbox cannot write to an LED processor, and this is where that stops
 * being a promise in a document.
 *
 * The rule the whole video module hangs off is "watch the wall, don't drive
 * it". Every other guard is a type or a comment, and both of those survive
 * exactly as long as the next person to read them. This one reads the source.
 *
 * It is the same trick `dmxListener.test.ts` plays on `receiveOnly`, for the
 * same reason: the module opens sockets onto a network that is carrying a
 * show, and a regression here would be silent, remote and expensive. If this
 * test fails, the question is not "how do I get the test to pass".
 */

const dir = join(fileURLToPath(new URL('../src/video/', import.meta.url)))

const sources = readdirSync(dir)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({ name: f, text: readFileSync(join(dir, f), 'utf8') }))

/** Strip comments, so prose about SetRequest doesn't read as a SetRequest. */
const code = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('the video module is structurally read-only', () => {
  it('has source files to check', () => {
    // A rename that emptied this list would make every assertion below pass
    // vacuously, which is the one way a guard like this fails quietly.
    expect(sources.length).toBeGreaterThanOrEqual(4)
  })

  it('contains no SNMP SetRequest tag', () => {
    // 0xa3 is SetRequest. The encoder takes a `PduType` with two members, so
    // the compiler already refuses it; this catches somebody widening the
    // type, or hand-assembling a PDU beside it.
    for (const { name, text } of sources) {
      expect(code(text), `${name} mentions the SetRequest PDU tag`).not.toMatch(/0xa3/i)
    }
  })

  it('issues no HTTP verb other than GET', () => {
    // An allowlist, not a blocklist of write verbs. The blocklist matched
    // upper-case quoted literals only, so `method: 'post'`, a template
    // literal, or a `method: verb` computed anywhere at all went straight
    // through the one test that exists to stop it. Every `method:` in this
    // directory has to be the literal 'GET' — including the ones in types,
    // which is where the compiler's half of the guarantee lives.
    let checked = 0
    for (const { name, text } of sources) {
      for (const use of code(text).matchAll(/\bmethod\s*:\s*([^,\n}]+)/g)) {
        checked++
        expect(use[1].trim(), `${name} sets an HTTP method that is not the literal 'GET'`).toBe(
          "'GET'"
        )
      }
    }
    // A rename that moved the fetch out of this directory would otherwise
    // leave this loop with nothing to iterate and passing.
    expect(checked).toBeGreaterThan(0)
  })

  it('never opens the register bus', () => {
    // Port 5200 is a stateful control session NovaLCT may hold exclusively.
    // Connecting to it out of curiosity could take the desk away from the
    // operator using it, so nothing here connects — not even to check that
    // something is listening. `REGISTER_BUS_PORT` is exported from shared as
    // documentation; what must not appear is a connection to it.
    for (const { name, text } of sources) {
      expect(code(text), `${name} opens a TCP connection`).not.toMatch(
        /createConnection|net\.connect|new\s+net\.Socket/
      )
    }
  })

  it('keeps the discovery probe to the one documented payload', () => {
    const discovery = sources.find((s) => s.name === 'discovery.ts')
    expect(discovery).toBeDefined()
    const sends = code(discovery!.text).match(/\.send\(/g) ?? []
    // One send call, in one loop over the broadcast and multicast targets.
    // A second would be a second kind of packet, which is a decision, not a
    // refactor.
    expect(sends).toHaveLength(1)
    expect(discovery!.text).toContain("Buffer.from('rqProMI:', 'ascii')")
  })

  it('never asks fetch to follow a redirect', () => {
    // The port is chosen by whatever answers, once a redirect is followed —
    // so `redirect` being anything but the literal 'error' hands the choice
    // of destination to the far end, and 5200 is a destination.
    const coex = sources.find((s) => s.name === 'coex.ts')
    expect(coex).toBeDefined()
    expect(code(coex!.text)).toContain("redirect: 'error'")
    for (const { name, text } of sources) {
      expect(code(text), `${name} allows redirects to be followed`).not.toMatch(
        /redirect:\s*['"](follow|manual)['"]/
      )
    }
  })

  it('transmits from nowhere but SNMP GETs and the discovery probe', () => {
    // coex.ts goes out over the injected fetch, snmp.ts and discovery.ts over
    // UDP. Any other file in here gaining a socket send is worth a look.
    const senders = sources
      .filter((s) => /\.send\(|\.sendto\(/.test(code(s.text)))
      .map((s) => s.name)
    expect(senders.sort()).toEqual(['discovery.ts', 'snmp.ts'])
  })
})

/**
 * The same rule, against real sockets.
 *
 * Everything above reads the source, which catches the change somebody makes
 * on purpose. It could not catch this one, because nothing in the source was
 * wrong: `fetch` follows redirects by default, so a host at the address an
 * admin typed could answer `302 Location: http://<processor>:5200/` and the
 * box would open TCP to the register bus and write an HTTP request into it,
 * every twenty seconds, with `method: 'GET'` intact the whole way. That is
 * the one thing this module must never do, and no amount of grepping this
 * directory would have shown it.
 *
 * So this drives the real adapter — `realWatcherIo.coex.fetch`, the one the
 * box actually uses — and watches the bus. It needs the real ports, because
 * the adapter's other guard is the port and using any other would prove only
 * that guard: the COEX API's 8001 for the host that lies, and 5200 for the
 * bus. Both unprivileged; if either is taken the test says so rather than
 * passing quietly.
 */
describe('the real adapter, against something that redirects', () => {
  /** Bind exactly this port, or say why the test cannot run. */
  const listenOn = async (server: HttpServer | NetServer, port: number): Promise<boolean> =>
    new Promise((resolve) => {
      server.once('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => resolve(true))
    })

  let bus: NetServer
  let hostile: HttpServer
  /** Anything at all arriving at the bus is the failure. */
  let reached: string[]

  beforeEach(() => {
    reached = []
    bus = netServer((socket) => {
      socket.on('data', (data: Buffer) => {
        reached.push(String(data).split('\r\n')[0] ?? '')
        socket.destroy()
      })
    })
    hostile = createServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${REGISTER_BUS_PORT}/` })
      res.end()
    })
  })

  afterEach(async () => {
    await new Promise<void>((r) => bus.close(() => r()))
    await new Promise<void>((r) => hostile.close(() => r()))
  })

  it('opens nothing to the register bus a redirect points at', async () => {
    const gotBus = await listenOn(bus, REGISTER_BUS_PORT)
    const gotCoex = await listenOn(hostile, COEX_HTTP_PORT)
    expect(gotBus && gotCoex, 'ports 5200 and 8001 must be free for this test').toBe(true)

    await expect(
      realWatcherIo.coex.fetch(`http://127.0.0.1:${COEX_HTTP_PORT}/api/v1/device`, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(2000),
      })
    ).rejects.toThrow()

    // A moment for a connection to land, if one were going to.
    await new Promise((r) => setTimeout(r, 200))
    expect(reached, 'the box connected to the register bus').toEqual([])
  })

  it('refuses before opening anything when the address is the bus itself', async () => {
    const gotBus = await listenOn(bus, REGISTER_BUS_PORT)
    expect(gotBus, 'port 5200 must be free for this test').toBe(true)

    // Thrown, not rejected: the guard runs before there is a promise, which
    // is the point — nothing is opened, not even briefly. `CoexReader.get`
    // awaits inside a try, so a synchronous throw there is caught like any
    // other failed read.
    expect(() =>
      realWatcherIo.coex.fetch(`http://127.0.0.1:${REGISTER_BUS_PORT}/api/v1/device`, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(2000),
      })
    ).toThrow(/read-only/)
    await new Promise((r) => setTimeout(r, 200))
    expect(reached).toEqual([])
  })
})
