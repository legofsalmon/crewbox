import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  certDaysLeft,
  certNames,
  probeEnvironment,
  worstEnvState,
  type Probes,
} from '../src/environment.ts'

/**
 * The probes are injected, so none of this touches a network. What is under
 * test is the judgement: which situations are problems, which are merely
 * worth knowing, and whether the copy tells an admin what to do.
 *
 * The load-bearing case is a box with no internet. Crewbox is for exactly
 * that, so if this suite ever lets "no internet" become a warning, the panel
 * has started lying about the product.
 */

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A real certificate, because parsing one is half of what this module does. */
const makeCert = (cn: string, days = 90): string => {
  const dir = mkdtempSync(join(tmpdir(), 'crewbox-env-'))
  dirs.push(dir)
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
      '-days',
      String(days),
      '-subj',
      `/CN=${cn}`,
    ],
    { stdio: 'ignore' }
  )
  return readFileSync(join(dir, 'cert.pem'), 'utf8')
}

const probes = (over: Partial<Probes> = {}): Probes => ({
  tcpReachable: async () => false,
  noContentOk: async () => false,
  resolve4: async () => [],
  localAddresses: () => ['192.168.1.50'],
  certPem: () => null,
  now: () => Date.now(),
  ...over,
})

const find = (checks: Awaited<ReturnType<typeof probeEnvironment>>['checks'], id: string) =>
  checks.find((c) => c.id === id)

describe('internet', () => {
  it('treats no internet as normal, not as a fault', async () => {
    // The whole product is for this case. A warning here would be wrong, and
    // would teach an admin to ignore the panel.
    const { checks } = await probeEnvironment(probes())
    const net = find(checks, 'internet')!
    expect(net.state).toBe('info')
    expect(net.detail).toMatch(/normal state on site/)
    expect(worstEnvState(checks)).toBe('ok')
  })

  it('reports a working uplink when one is really there', async () => {
    const { checks } = await probeEnvironment(
      probes({ tcpReachable: async () => true, noContentOk: async () => true })
    )
    expect(find(checks, 'internet')!.state).toBe('ok')
  })

  it('catches a captive portal, which looks exactly like internet', async () => {
    // TCP connects fine and every fetch returns a login page — the case that
    // silently breaks certbot while appearing connected.
    const { checks } = await probeEnvironment(
      probes({ tcpReachable: async () => true, noContentOk: async () => false })
    )
    const net = find(checks, 'internet')!
    expect(net.state).toBe('limited')
    expect(net.detail).toMatch(/captive portal/)
  })
})

describe('network address', () => {
  it('is happy with a single private address', async () => {
    const { checks } = await probeEnvironment(probes())
    const addr = find(checks, 'address')!
    expect(addr.state).toBe('ok')
    expect(addr.detail).toContain('192.168.1.50')
  })

  it('calls out a self-assigned address as a dead network', async () => {
    // 169.254.x means the interface is up and no DHCP answered — it looks
    // like a working network until a phone tries to connect.
    const { checks } = await probeEnvironment(probes({ localAddresses: () => ['169.254.10.4'] }))
    const addr = find(checks, 'address')!
    expect(addr.state).toBe('off')
    expect(addr.detail).toMatch(/no DHCP/)
  })

  it('flags more than one address, because the QR can only carry one', async () => {
    const { checks } = await probeEnvironment(
      probes({ localAddresses: () => ['192.168.1.50', '10.0.0.9'] })
    )
    const addr = find(checks, 'address')!
    expect(addr.state).toBe('limited')
    expect(addr.detail).toContain('10.0.0.9')
  })

  it('says so when nothing can reach this machine at all', async () => {
    const { checks } = await probeEnvironment(probes({ localAddresses: () => [] }))
    expect(find(checks, 'address')!.state).toBe('off')
  })
})

describe('the local DNS trick', () => {
  it('is satisfied when the certificate name points at this box', async () => {
    const { checks } = await probeEnvironment(
      probes({
        certPem: () => makeCert('chat.letissier.ie'),
        resolve4: async () => ['192.168.1.50'],
      })
    )
    const host = find(checks, 'hostname')!
    expect(host.state).toBe('ok')
    expect(host.label).toContain('chat.letissier.ie')
  })

  it('warns when the name resolves somewhere else entirely', async () => {
    // Usually the public record, or last year's box.
    const { checks } = await probeEnvironment(
      probes({
        certPem: () => makeCert('chat.letissier.ie'),
        resolve4: async () => ['203.0.113.7'],
      })
    )
    const host = find(checks, 'hostname')!
    expect(host.state).toBe('limited')
    expect(host.detail).toContain('203.0.113.7')
    // The advice must rule out the obvious-but-wrong fix, or someone will
    // "solve" it with a public A record that cannot resolve in a field.
    expect(host.fix).toMatch(/Public DNS cannot fix this/)
    expect(host.fix).toMatch(/venue router/)
  })

  it('warns when the name does not resolve, so the certificate goes unused', async () => {
    const { checks } = await probeEnvironment(
      probes({ certPem: () => makeCert('chat.example.com') })
    )
    const host = find(checks, 'hostname')!
    expect(host.state).toBe('limited')
    expect(host.fix).toMatch(/DNS config/)
  })

  it('says nothing at all on a box with no certificate', async () => {
    // Nothing to check, and an empty row would just be noise.
    const { checks } = await probeEnvironment(probes())
    expect(find(checks, 'hostname')).toBeUndefined()
    expect(find(checks, 'certificate')).toBeUndefined()
  })
})

describe('certificate and clock', () => {
  it('reads the names a certificate claims', () => {
    expect(certNames(makeCert('chat.letissier.ie'))).toContain('chat.letissier.ie')
  })

  it('counts the days left', () => {
    const days = certDaysLeft(makeCert('chat.letissier.ie', 90), Date.now())
    expect(days).toBeGreaterThan(85)
    expect(days).toBeLessThanOrEqual(90)
  })

  it('warns while there is still time to renew', async () => {
    // Renewal needs internet and the site will not have any, so the warning
    // has to arrive before anyone travels.
    const { checks } = await probeEnvironment(probes({ certPem: () => makeCert('c.example', 10) }))
    const cert = find(checks, 'certificate')!
    expect(cert.state).toBe('limited')
    expect(cert.fix).toMatch(/before you travel/)
  })

  it('treats an expired certificate as broken', async () => {
    const pem = makeCert('c.example', 1)
    const { checks } = await probeEnvironment(
      probes({ certPem: () => pem, now: () => Date.now() + 5 * 86_400_000 })
    )
    expect(find(checks, 'certificate')!.state).toBe('off')
  })

  it('catches a clock set before the certificate exists', async () => {
    // A box that lost its clock rejects its own certificate and mints voice
    // tokens dated in the future; with no internet there is nothing to sync
    // from, so this has to be said out loud.
    const pem = makeCert('c.example')
    const { checks } = await probeEnvironment(
      probes({ certPem: () => pem, now: () => Date.now() - 30 * 86_400_000 })
    )
    const clock = find(checks, 'clock')!
    expect(clock.state).toBe('off')
    expect(clock.fix).toMatch(/set it by hand/)
  })
})

describe('summary', () => {
  it('never lets info colour the result', async () => {
    // A box with no internet and nothing else wrong is a healthy box.
    const { checks } = await probeEnvironment(probes())
    expect(checks.some((c) => c.state === 'info')).toBe(true)
    expect(worstEnvState(checks)).toBe('ok')
  })

  it('reports the worst real problem', () => {
    expect(
      worstEnvState([
        { id: 'a', label: '', state: 'info', detail: '' },
        { id: 'b', label: '', state: 'limited', detail: '' },
        { id: 'c', label: '', state: 'off', detail: '' },
      ])
    ).toBe('off')
  })
})
