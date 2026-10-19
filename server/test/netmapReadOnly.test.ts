import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The network map sends nothing, and this is where that stops being a
 * promise in a document.
 *
 * Its inputs are what the watchers already overheard and the tables the
 * operating system keeps. The only way it could put a packet on a show
 * network is by running a command that does, and three of the commands it
 * runs have a form that does: `arp` without `-n` looks every address up in
 * DNS on a Mac, `nmcli dev wifi list` without `--rescan no` starts a scan
 * when its list is old, and `iw dev <x> scan` (not `scan dump`) is a scan.
 * So the directory may run exactly the commands listed here, and no socket.
 */

const dir = join(fileURLToPath(new URL('../src/netmap/', import.meta.url)))
const sources = readdirSync(dir)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({ name: f, text: readFileSync(join(dir, f), 'utf8') }))

const code = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('the network map is structurally read-only', () => {
  it('has source files to check', () => {
    expect(sources.length).toBeGreaterThanOrEqual(4)
  })

  it('opens no socket of any kind', () => {
    for (const { name, text } of sources) {
      expect(code(text), name).not.toMatch(/node:(dgram|net|http|https|tls|dns)['"]/)
      expect(code(text), name).not.toMatch(/\bfetch\(/)
    }
  })

  it('runs only the read forms of its commands', () => {
    const runs = sources.flatMap(({ name, text }) =>
      [...code(text).matchAll(/io\.run\(\s*'([^']+)'\s*,\s*\[([\s\S]*?)\]/g)].map((m) => ({
        name,
        cmd: m[1]!,
        args: m[2]!.replace(/\s+/g, ' ').trim(),
      }))
    )
    expect(runs.map((r) => `${r.cmd} ${r.args}`).sort()).toEqual(
      [
        "arp '-a'",
        "arp '-an'",
        "iw 'dev', adapter, 'scan', 'dump'",
        "iw 'dev', adapter, 'survey', 'dump'",
        "networkctl 'lldp', '--json=short'",
        "nmcli '-t', '-f', NMCLI_FIELDS, 'dev', 'wifi', 'list', 'ifname', adapter, '--rescan', 'no',",
      ].sort()
    )
  })

  it('runs arp -a only on Windows, where arp never resolves names', () => {
    const system = code(sources.find((s) => s.name === 'system.ts')!.text)
    expect(system).toMatch(
      /io\.platform === 'win32'\) return got\(parseArpWindows\(await io\.run\('arp', \['-a'\]\)\)\)/
    )
  })
})
