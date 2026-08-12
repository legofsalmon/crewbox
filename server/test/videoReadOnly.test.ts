import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

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
    for (const { name, text } of sources) {
      expect(code(text), `${name} uses a write verb`).not.toMatch(/['"](POST|PUT|PATCH|DELETE)['"]/)
    }
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

  it('transmits from nowhere but SNMP GETs and the discovery probe', () => {
    // coex.ts goes out over the injected fetch, snmp.ts and discovery.ts over
    // UDP. Any other file in here gaining a socket send is worth a look.
    const senders = sources
      .filter((s) => /\.send\(|\.sendto\(/.test(code(s.text)))
      .map((s) => s.name)
    expect(senders.sort()).toEqual(['discovery.ts', 'snmp.ts'])
  })
})
