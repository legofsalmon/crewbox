import { X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Resolver } from 'node:dns/promises'
import { createConnection } from 'node:net'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'

/**
 * What the network around this box looks like.
 *
 * readiness.ts answers "what can this box do". This answers "what has it been
 * plugged into", which is a different question with a different failure mode:
 * the box is usually fine and the site is not. A DHCP lease that never
 * arrived, a hostname that resolves to the old box, a certificate that
 * expires on the Saturday — none of those are software faults, and none of
 * them show up until crew can't connect.
 *
 * The governing rule here is that **no internet is normal**. Crewbox exists
 * to work without one, so an environment panel that flags a missing uplink as
 * a fault would be both wrong and training an admin to ignore the panel. That
 * is why these checks carry an `info` state that readiness has no use for:
 * some of this is worth knowing and nothing to fix.
 *
 * Everything is bounded and fails soft. A probe that hangs reports "couldn't
 * tell" rather than delaying a page or throwing.
 */

/** `info` = worth knowing, nothing wrong. See the note above about internet. */
export type EnvState = 'ok' | 'info' | 'limited' | 'off'

export interface EnvCheck {
  id: string
  label: string
  state: EnvState
  /** What's true now. */
  detail: string
  /** What to do about it, when there is something to do. */
  fix?: string
}

export interface EnvironmentReport {
  checks: EnvCheck[]
  /** When this was probed, so the panel can say how stale it is. */
  probedAt: number
}

export interface Probes {
  /** TCP connect succeeds within the timeout. */
  tcpReachable: (host: string, port: number, timeoutMs: number) => Promise<boolean>
  /** A known endpoint answers 204 with no body — proves a real uplink, not a portal. */
  noContentOk: (timeoutMs: number) => Promise<boolean>
  /** Resolve a name to IPv4 addresses; empty when it doesn't resolve. */
  resolve4: (host: string, timeoutMs: number) => Promise<string[]>
  /** Non-internal IPv4 addresses of this machine. */
  localAddresses: () => string[]
  /** PEM of the box's certificate, when it has one. */
  certPem: () => string | null
  now: () => number
}

const timeout = <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))])

export const realProbes: Probes = {
  tcpReachable: (host, port, timeoutMs) =>
    new Promise((resolve) => {
      const socket = createConnection({ host, port })
      const done = (result: boolean) => {
        socket.destroy()
        resolve(result)
      }
      socket.once('connect', () => done(true))
      socket.once('error', () => done(false))
      socket.setTimeout(timeoutMs, () => done(false))
    }),

  // Android's own captive-portal probe. A portal answers 200 with a login
  // page, which is exactly the case a plain TCP connect cannot distinguish
  // from a working uplink — and the case that silently breaks certbot.
  noContentOk: async (timeoutMs) => {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const res = await fetch('http://connectivitycheck.gstatic.com/generate_204', {
        signal: controller.signal,
        redirect: 'manual',
      })
      clearTimeout(timer)
      return res.status === 204
    } catch {
      return false
    }
  },

  resolve4: async (host, timeoutMs) => {
    const resolver = new Resolver({ timeout: timeoutMs, tries: 1 })
    try {
      return await timeout(resolver.resolve4(host), timeoutMs, [])
    } catch {
      return []
    }
  },

  localAddresses: () => {
    const out: string[] = []
    for (const addrs of Object.values(networkInterfaces())) {
      for (const addr of addrs ?? []) {
        if (addr.family === 'IPv4' && !addr.internal) out.push(addr.address)
      }
    }
    return out
  },

  certPem: () => null,
  now: () => Date.now(),
}

/** Real probes, reading this box's certificate from its data directory. */
export const boxProbes = (dataDir: string | undefined): Probes => ({
  ...realProbes,
  certPem: () => {
    if (!dataDir) return null
    try {
      return readFileSync(join(dataDir, 'cert.pem'), 'utf8')
    } catch {
      return null
    }
  },
})

/**
 * A cached report, refreshed on demand.
 *
 * Probing takes seconds in the bad cases — a dead uplink is discovered by
 * waiting — and the admin panel must never sit on that. The panel reads
 * whatever the last sweep found and says when it was taken; refreshing is the
 * admin's choice, because the answer only changes when the site does.
 */
export function createEnvironmentCache(probes: Probes) {
  let report: EnvironmentReport | null = null
  let inFlight: Promise<EnvironmentReport> | null = null

  const refresh = (): Promise<EnvironmentReport> => {
    // One sweep at a time: a panel opened on three laptops shouldn't start
    // three sets of probes against the same network.
    inFlight ??= probeEnvironment(probes)
      .then((result) => {
        report = result
        return result
      })
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }

  return {
    /** Last result, or null before the first sweep finishes. */
    current: (): EnvironmentReport | null => report,
    refresh,
  }
}

/** Names a certificate claims: the CN plus any DNS SANs. */
export function certNames(pem: string): string[] {
  try {
    const cert = new X509Certificate(pem)
    const names = new Set<string>()
    const cn = /CN=([^,/\n]+)/.exec(cert.subject)?.[1]?.trim()
    if (cn) names.add(cn)
    for (const entry of cert.subjectAltName?.split(',') ?? []) {
      const value = entry.trim()
      if (value.startsWith('DNS:')) names.add(value.slice(4).trim())
    }
    // A wildcard can't be resolved or checked, and isn't what crew type.
    return [...names].filter((n) => n && !n.startsWith('*'))
  } catch {
    return []
  }
}

/** Days until the certificate expires; null when there isn't one to read. */
export function certDaysLeft(pem: string, now: number): number | null {
  try {
    const validTo = new Date(new X509Certificate(pem).validTo).getTime()
    if (!Number.isFinite(validTo)) return null
    return Math.floor((validTo - now) / 86_400_000)
  } catch {
    return null
  }
}

const LINK_LOCAL = /^169\.254\./
const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/

async function addressCheck(probes: Probes): Promise<EnvCheck> {
  const addresses = probes.localAddresses()

  if (addresses.length === 0) {
    return {
      id: 'address',
      label: 'Network address',
      state: 'off',
      detail: 'This machine has no network address other than its own loopback.',
      fix: 'Plug it into the crew network, or join the crew Wi-Fi. Nothing else can reach it until then.',
    }
  }

  const linkLocal = addresses.filter((a) => LINK_LOCAL.test(a))
  if (linkLocal.length === addresses.length) {
    return {
      id: 'address',
      label: 'Network address',
      state: 'off',
      // 169.254.x means the interface is up and nothing answered — this looks
      // like a working network right up until a phone tries to connect.
      detail: `Only a self-assigned address (${addresses[0]}), which means no DHCP server answered.`,
      fix: 'Check the router is powered and this machine is on the right port or SSID. A self-assigned address cannot be reached by crew.',
    }
  }

  const routable = addresses.filter((a) => !LINK_LOCAL.test(a))
  if (routable.length > 1) {
    return {
      id: 'address',
      label: 'Network address',
      state: 'limited',
      detail: `More than one: ${routable.join(', ')}.`,
      fix: 'Crew must use the one on the crew network. Put that address on the poster, and consider unplugging the other interface so the QR cannot pick the wrong one.',
    }
  }

  const address = routable[0]
  return {
    id: 'address',
    label: 'Network address',
    state: 'ok',
    detail: PRIVATE.test(address)
      ? `${address} — a private address, as a crew network should be.`
      : `${address}.`,
  }
}

async function internetCheck(probes: Probes): Promise<EnvCheck[]> {
  // Two well-known resolvers rather than one, so a single blocked address
  // doesn't read as "no internet".
  const reachable =
    (await probes.tcpReachable('1.1.1.1', 443, 2000)) ||
    (await probes.tcpReachable('8.8.8.8', 443, 2000))

  if (!reachable) {
    return [
      {
        id: 'internet',
        label: 'Internet',
        state: 'info',
        // Deliberately not a warning. This is the state the product is for.
        detail: 'None — which is the normal state on site, and nothing here needs it.',
        fix: 'Chat, voice, patch sheets and lighting all work without it. You only need internet to renew a certificate or fetch a new release, both of which are done before you travel.',
      },
    ]
  }

  const real = await probes.noContentOk(3000)
  if (!real) {
    return [
      {
        id: 'internet',
        label: 'Internet',
        state: 'limited',
        // The nastiest of the three states: everything looks connected and
        // anything that actually fetches gets a login page instead.
        detail: 'Something answers, but a captive portal is intercepting traffic.',
        fix: 'Open any website on this machine and sign in to the venue Wi-Fi, or ignore it — the box does not need internet. Certificate renewal and release downloads will fail until it is signed in.',
      },
    ]
  }

  return [
    {
      id: 'internet',
      label: 'Internet',
      state: 'ok',
      detail: 'Working. Certificate renewal and release downloads will work from here.',
    },
  ]
}

async function hostnameCheck(probes: Probes, addresses: string[]): Promise<EnvCheck | null> {
  const pem = probes.certPem()
  if (!pem) return null
  const names = certNames(pem)
  if (names.length === 0) return null

  const name = names[0]
  const resolved = await probes.resolve4(name, 2500)

  if (resolved.length === 0) {
    return {
      id: 'hostname',
      label: `Crew can reach ${name} by name`,
      state: 'limited',
      detail: `${name} does not resolve on this network.`,
      fix: `Crew phones will not find the box by name, so the certificate goes unused and they get no microphone. Download the DNS config below and put it on the venue router, or hand out the IP address instead and accept the certificate warning.`,
    }
  }

  const mine = resolved.filter((ip) => addresses.includes(ip))
  if (mine.length === 0) {
    return {
      id: 'hostname',
      label: `Crew can reach ${name} by name`,
      state: 'limited',
      // Usually the public DNS record, or last year's box.
      detail: `${name} resolves to ${resolved.join(', ')}, which is not this machine.`,
      fix: `Crew following that name will land somewhere else entirely — often a web host, if the domain has a wildcard record. Public DNS cannot fix this: a site with no uplink cannot reach it, and routers commonly refuse public answers pointing at private addresses. Download the DNS config below and put it on the venue router, which overrides both.`,
    }
  }

  return {
    id: 'hostname',
    label: `Crew can reach ${name} by name`,
    state: 'ok',
    detail: `${name} resolves to this box, so HTTPS works and browsers grant the microphone.`,
  }
}

function certificateCheck(probes: Probes): EnvCheck | null {
  const pem = probes.certPem()
  if (!pem) return null
  const days = certDaysLeft(pem, probes.now())
  if (days === null) return null

  if (days < 0) {
    return {
      id: 'certificate',
      label: 'Certificate',
      state: 'off',
      detail: `Expired ${-days} ${-days === 1 ? 'day' : 'days'} ago.`,
      fix: 'Browsers will warn every crew member, and some will refuse. Renew with deploy/cert-renew.sh while you still have internet.',
    }
  }
  if (days <= 21) {
    return {
      id: 'certificate',
      label: 'Certificate',
      state: 'limited',
      // Renewal needs internet, which the site will not have.
      detail: `Expires in ${days} ${days === 1 ? 'day' : 'days'}.`,
      fix: 'Renew before you travel — renewal needs internet, and the site will not have any.',
    }
  }
  return {
    id: 'certificate',
    label: 'Certificate',
    state: 'ok',
    detail: `Valid for another ${days} days.`,
  }
}

function clockCheck(probes: Probes): EnvCheck | null {
  const pem = probes.certPem()
  if (!pem) return null
  try {
    const cert = new X509Certificate(pem)
    const from = new Date(cert.validFrom).getTime()
    if (Number.isFinite(from) && probes.now() < from) {
      return {
        id: 'clock',
        label: 'Clock',
        state: 'off',
        // A box that lost its clock rejects its own certificate, and any
        // voice token it mints looks issued in the future.
        detail:
          'This machine thinks it is earlier than the date its own certificate becomes valid.',
        fix: 'Set the clock. Until it is right, browsers reject the certificate and voice tokens fail — and with no internet there is nothing to sync from, so set it by hand.',
      }
    }
  } catch {
    return null
  }
  return null
}

/** Probe the surroundings. Never throws; slow probes report rather than hang. */
export async function probeEnvironment(probes: Probes = realProbes): Promise<EnvironmentReport> {
  const addresses = probes.localAddresses().filter((a) => !LINK_LOCAL.test(a))

  const [address, internet, hostname] = await Promise.all([
    addressCheck(probes),
    internetCheck(probes),
    hostnameCheck(probes, addresses),
  ])

  const checks: EnvCheck[] = [address, ...internet]
  if (hostname) checks.push(hostname)
  const cert = certificateCheck(probes)
  if (cert) checks.push(cert)
  const clock = clockCheck(probes)
  if (clock) checks.push(clock)

  return { checks, probedAt: probes.now() }
}

/**
 * The worst state present, ignoring `info` — which by definition is not a
 * problem, and must never colour the summary.
 */
export const worstEnvState = (checks: EnvCheck[]): EnvState =>
  checks.some((c) => c.state === 'off')
    ? 'off'
    : checks.some((c) => c.state === 'limited')
      ? 'limited'
      : 'ok'
