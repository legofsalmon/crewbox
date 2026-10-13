/**
 * Keeping the router's DNS entry for this box pointed at it.
 *
 * The box's certificate is only usable when its name resolves, on the crew
 * network, to wherever the box is right now (dnsconfig.ts says why that has
 * to be a local override). The override is typed onto the router once — and
 * then goes stale the first time the box's address changes: a new DHCP
 * lease, the Mac on its other adapter, a spare box swapped in. Every phone
 * following the name then lands on the public web host and hangs, and so
 * does the box's own admin link, because it uses the same name.
 *
 * So, when an admin turns it on, the box keeps the entry right itself. It
 * logs in to the router over SSH and makes the dnsmasq override match its
 * current address, at start and whenever that address changes. That works
 * without the name resolving, which matters: the box is the one party that
 * never needs the name to reach the router.
 *
 * Opt in, and off by default, for three reasons:
 *
 *  - It needs the router's root password, stored on the box. That belongs
 *    only on a box whose owner also owns the router.
 *  - It only fits routers built on OpenWrt (GL.iNet, Turris, a plain OpenWrt
 *    install): SSH, `uci` and dnsmasq. A venue's router is none of those,
 *    and is not the box's to write to anyway.
 *  - A router is shared. The script below changes exactly the lines for this
 *    box's own name (and the phone probe names, only where the admin already
 *    pointed them at a box), and restarts dnsmasq only when something
 *    actually changed.
 *
 * The router's SSH host key is pinned on the first successful login and
 * checked on every one after, so the password is never handed to a
 * different machine that has taken the router's address.
 */

import { createHash } from 'node:crypto'
import { PROBE_HOSTS } from './captive.ts'
import type { Store } from './store.ts'

/** The settings row. Stored as JSON; never rename the key. */
export const ROUTER_DNS_KEY = 'routerDns'

export interface RouterDnsSettings {
  enabled: boolean
  /** The router's address on the crew network. */
  host: string
  port: number
  username: string
  password: string
  /** `SHA256:…` of the router's SSH host key, pinned on first success. */
  hostKey: string
}

export const ROUTER_DNS_DEFAULTS: RouterDnsSettings = {
  enabled: false,
  host: '',
  port: 22,
  username: 'root',
  password: '',
  hostKey: '',
}

export function loadRouterDns(store: Pick<Store, 'getSetting'>): RouterDnsSettings {
  const raw = store.getSetting(ROUTER_DNS_KEY)
  if (!raw) return { ...ROUTER_DNS_DEFAULTS }
  try {
    const saved = JSON.parse(raw) as Partial<RouterDnsSettings>
    return {
      enabled: saved.enabled === true,
      host: typeof saved.host === 'string' ? saved.host : '',
      port: typeof saved.port === 'number' ? saved.port : 22,
      username: typeof saved.username === 'string' && saved.username ? saved.username : 'root',
      password: typeof saved.password === 'string' ? saved.password : '',
      hostKey: typeof saved.hostKey === 'string' ? saved.hostKey : '',
    }
  } catch {
    // A row nobody can read is treated as never set, not as a crash at start.
    return { ...ROUTER_DNS_DEFAULTS }
  }
}

export function saveRouterDns(store: Pick<Store, 'setSetting'>, settings: RouterDnsSettings) {
  store.setSetting(ROUTER_DNS_KEY, JSON.stringify(settings))
}

/** What the entry should say: the certificate's name and the box's address. */
export interface DnsTarget {
  hostname: string
  address: string
}

// Both halves end up inside a shell script run as root on the router. They
// come from the box's own certificate and adapters, never from a request —
// and are still checked against these before a byte is sent.
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
const isIpv4 = (v: string): boolean =>
  /^(\d{1,3}\.){3}\d{1,3}$/.test(v) && v.split('.').every((octet) => Number(octet) <= 255)

export function validTarget(target: DnsTarget): boolean {
  return HOSTNAME.test(target.hostname.toLowerCase()) && isIpv4(target.address)
}

/**
 * The script the router runs. POSIX sh, because OpenWrt's is BusyBox ash.
 *
 * The box's name is made right wherever an entry for it already is: the
 * `dhcp` config's address list (what LuCI and GL.iNet's own screens edit),
 * /etc/dnsmasq.conf, or a file in /etc/dnsmasq.d — the three places people
 * put one by hand, and the last is where the downloaded crewbox-dns.conf
 * says to. Where there is none anywhere, one is added to the `dhcp` config,
 * which survives a firmware upgrade that keeps settings.
 *
 * The probe names are only corrected, never added. Pointing phones'
 * connectivity checks at the box is a choice an admin makes deliberately
 * (dnsconfig.ts); following the box to a new address is not a new choice.
 *
 * It prints one line the box reads back: `crewbox: updated` or
 * `crewbox: unchanged`. `root` moves /etc for the tests.
 */
export function routerScript(target: DnsTarget, root = ''): string {
  if (!validTarget(target)) throw new Error('refusing to write an invalid name or address')
  const name = target.hostname.toLowerCase()
  const probes = PROBE_HOSTS.filter((host) => HOSTNAME.test(host)).join(' ')
  return `set -u
addr='${target.address}'
etc='${root}/etc'
changed=0
command -v uci >/dev/null 2>&1 || { echo 'crewbox: no uci'; exit 3; }

# fix NAME ADD: point every override for NAME at $addr; with ADD=1, create
# one when there is none.
fix() {
  name=$1; add=$2; found=0
  want="/$name/$addr"
  for entry in $(uci -q get dhcp.@dnsmasq[0].address); do
    case "$entry" in
      "/$name/"*)
        found=1
        if [ "$entry" != "$want" ]; then
          uci del_list dhcp.@dnsmasq[0].address="$entry"
          uci add_list dhcp.@dnsmasq[0].address="$want"
          changed=1
        fi ;;
    esac
  done
  re=$(printf '%s' "$name" | sed 's/[.]/[.]/g')
  for file in "$etc/dnsmasq.conf" "$etc"/dnsmasq.d/*.conf; do
    [ -f "$file" ] || continue
    grep -q "^address=/$re/" "$file" || continue
    found=1
    if grep "^address=/$re/" "$file" | grep -qv "^address=$want\\$"; then
      sed -i "s#^address=/$re/.*#address=$want#" "$file"
      changed=1
    fi
  done
  if [ "$found" = 0 ] && [ "$add" = 1 ]; then
    uci add_list dhcp.@dnsmasq[0].address="$want"
    changed=1
  fi
}

fix '${name}' 1
for probe in ${probes}; do fix "$probe" 0; done

if [ "$changed" = 1 ]; then
  uci commit dhcp
  "$etc/init.d/dnsmasq" restart >/dev/null 2>&1
  echo 'crewbox: updated'
else
  echo 'crewbox: unchanged'
fi
`
}

/** `SHA256:…`, the way `ssh-keygen -l` prints a host key. */
export function fingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

export interface SshRequest {
  host: string
  port: number
  username: string
  password: string
  /** Pinned fingerprint to require; empty to accept and report the key. */
  hostKey: string
  script: string
  timeoutMs: number
}

export interface SshResult {
  /** The key the router presented, for pinning. */
  hostKey: string
  stdout: string
  stderr: string
  code: number | null
}

/** Thrown when the router is not the one that was pinned. */
export class HostKeyMismatch extends Error {
  constructor(readonly presented: string) {
    super('host key mismatch')
  }
}

export type SshRunner = (request: SshRequest) => Promise<SshResult>

/**
 * Run a script on the router over SSH, piping it to `sh` rather than passing
 * it as the command, so no quoting survives into a second shell.
 */
export const runOverSsh: SshRunner = async (request) => {
  // Loaded when first used, not at start: a box with this off never needs it.
  const { Client } = await import('ssh2')
  return new Promise<SshResult>((resolve, reject) => {
    const client = new Client()
    let presented = ''
    let mismatch = false
    let settled = false
    const finish = (err: Error | null, result?: SshResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      client.end()
      if (err) reject(err)
      else resolve(result!)
    }
    const timer = setTimeout(
      () => finish(new Error('The router took too long to answer.')),
      request.timeoutMs
    )
    client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, answer) => {
      // Some dropbear builds ask for the password this way instead.
      answer(prompts.map(() => request.password))
    })
    client.on('error', (err) => finish(mismatch ? new HostKeyMismatch(presented) : err))
    // A connection dropped without an error still ends the attempt.
    client.on('close', () =>
      finish(mismatch ? new HostKeyMismatch(presented) : new Error('The router hung up.'))
    )
    client.on('ready', () => {
      client.exec('sh -s', (err, stream) => {
        if (err) return finish(err)
        let stdout = ''
        let stderr = ''
        // The exit status arrives on its own event; `close` may carry none.
        let code: number | null = null
        stream.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
        stream.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
        stream.on('exit', (status: number | null) => (code = status))
        stream.on('close', () => finish(null, { hostKey: presented, stdout, stderr, code }))
        stream.end(request.script)
      })
    })
    client.connect({
      host: request.host,
      port: request.port,
      username: request.username,
      password: request.password,
      tryKeyboard: true,
      readyTimeout: request.timeoutMs,
      hostVerifier: (key: Buffer) => {
        presented = fingerprint(key)
        // Refused here, and reported from the error ssh2 raises for it:
        // ending the connection from inside its own key exchange is not safe.
        mismatch = Boolean(request.hostKey) && presented !== request.hostKey
        return !mismatch
      },
    })
  })
}

export type RouterDnsState = 'off' | 'waiting' | 'working' | 'ok' | 'failed'

export interface RouterDnsStatus {
  state: RouterDnsState
  /** One sentence for the panel. */
  message: string
  /** When the router last answered (ms), or 0. */
  at: number
  /** What it was last set to, when it has been. */
  target?: DnsTarget
}

export interface RouterDnsOptions {
  store: Pick<Store, 'getSetting' | 'setSetting'>
  /** Where the name should point right now; null when the box has no name or no address. */
  target: () => DnsTarget | null
  run?: SshRunner
  now?: () => number
  log?: { info: (msg: string) => void; warn: (msg: string) => void }
  /** How often to look for an address change. Cheap: no network. */
  checkMs?: number
  timeoutMs?: number
}

const RETRY_MIN_MS = 60_000
const RETRY_MAX_MS = 15 * 60_000

/**
 * The part that decides when to talk to the router. It looks at the box's
 * own address every `checkMs`, which costs nothing, and logs in only when
 * that has moved since the router last confirmed it, when the settings
 * change, when asked, or to retry a failure with backoff.
 */
export class RouterDnsSync {
  private readonly run: SshRunner
  private readonly now: () => number
  private timer: ReturnType<typeof setInterval> | undefined
  private inFlight: Promise<RouterDnsStatus> | undefined
  /** What the router last confirmed, as `name address`. */
  private confirmed = ''
  private failures = 0
  private retryAt = 0
  private current: RouterDnsStatus

  constructor(private readonly options: RouterDnsOptions) {
    this.run = options.run ?? runOverSsh
    this.now = options.now ?? Date.now
    this.current = this.idle()
  }

  settings(): RouterDnsSettings {
    return loadRouterDns(this.options.store)
  }

  status(): RouterDnsStatus {
    return this.current
  }

  start(): void {
    if (this.timer) return
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.options.checkMs ?? 30_000)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** Save new settings. Anything that changes who to log in to forgets what was confirmed. */
  save(next: RouterDnsSettings): void {
    const before = this.settings()
    if (
      before.host !== next.host ||
      before.port !== next.port ||
      before.username !== next.username ||
      before.password !== next.password ||
      before.hostKey !== next.hostKey ||
      !before.enabled
    ) {
      this.confirmed = ''
    }
    // A different router is a different machine: its key is not the old one's.
    if (before.host !== next.host || before.port !== next.port) next = { ...next, hostKey: '' }
    saveRouterDns(this.options.store, next)
    this.failures = 0
    this.retryAt = 0
    this.current = this.idle()
  }

  /** The periodic check. Resolves once any login it started is over. */
  async tick(): Promise<void> {
    const settings = this.settings()
    if (!settings.enabled) {
      this.current = this.idle()
      return
    }
    const target = this.options.target()
    const key = target ? `${target.hostname} ${target.address}` : ''
    if (key && key === this.confirmed) return
    if (this.failures > 0 && this.now() < this.retryAt) return
    await this.sync()
  }

  /** Log in now, whatever the last result was. */
  sync(): Promise<RouterDnsStatus> {
    this.inFlight ??= this.attempt().finally(() => (this.inFlight = undefined))
    return this.inFlight
  }

  private idle(): RouterDnsStatus {
    const settings = this.settings()
    if (!settings.enabled) return { state: 'off', message: 'Off.', at: 0 }
    return { state: 'waiting', message: 'Waiting to check the router.', at: 0 }
  }

  private fail(message: string): RouterDnsStatus {
    this.failures++
    const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** (this.failures - 1))
    this.retryAt = this.now() + delay
    this.current = { state: 'failed', message, at: this.current.at }
    this.options.log?.warn(`router DNS: ${message}`)
    return this.current
  }

  private async attempt(): Promise<RouterDnsStatus> {
    const settings = this.settings()
    if (!settings.enabled) return (this.current = this.idle())
    if (!settings.host || !settings.password) {
      return this.fail('Add the router’s address and password.')
    }
    const target = this.options.target()
    if (!target) {
      return this.fail('This box has no certificate name or no network address to point it at yet.')
    }
    if (!validTarget(target)) {
      return this.fail(
        `${target.hostname} → ${target.address} is not something to write to a router.`
      )
    }
    this.current = { ...this.current, state: 'working', message: 'Updating the router…' }
    let result: SshResult
    try {
      result = await this.run({
        host: settings.host,
        port: settings.port,
        username: settings.username,
        password: settings.password,
        hostKey: settings.hostKey,
        script: routerScript(target),
        timeoutMs: this.options.timeoutMs ?? 15_000,
      })
    } catch (err) {
      return this.fail(describeFailure(err, settings))
    }
    const said = /crewbox: (updated|unchanged|no uci)/.exec(result.stdout)?.[1]
    if (said === 'no uci') {
      return this.fail(
        `${settings.host} is not an OpenWrt router (no uci), so the box cannot set its DNS. Put the downloaded DNS config on it by hand.`
      )
    }
    if (result.code !== 0 || !said) {
      const detail = (result.stderr || result.stdout).trim().split('\n').pop() ?? ''
      return this.fail(`The router could not apply the change${detail ? `: ${detail}` : '.'}`)
    }
    // Pinned only once a login has worked, so a typo'd address never pins
    // the key of whatever happened to answer there.
    if (!settings.hostKey && result.hostKey) {
      saveRouterDns(this.options.store, { ...settings, hostKey: result.hostKey })
    }
    this.confirmed = `${target.hostname} ${target.address}`
    this.failures = 0
    this.retryAt = 0
    const when = this.now()
    this.current = {
      state: 'ok',
      message:
        said === 'updated'
          ? `Pointed ${target.hostname} at ${target.address} on the router.`
          : `The router already points ${target.hostname} at ${target.address}.`,
      at: when,
      target,
    }
    if (said === 'updated') {
      this.options.log?.info(`router DNS: ${target.hostname} now points at ${target.address}`)
    }
    return this.current
  }
}

function describeFailure(err: unknown, settings: RouterDnsSettings): string {
  if (err instanceof HostKeyMismatch) {
    return `The router at ${settings.host} is not the one the box logged in to before (its key is now ${err.presented}). If you reset or replaced it, choose “Forget the router’s key” and save.`
  }
  const e = err as { level?: string; code?: string; message?: string }
  if (e.level === 'client-authentication') {
    return `The router at ${settings.host} refused the username or password.`
  }
  if (e.code === 'ECONNREFUSED') {
    return `Nothing is accepting SSH at ${settings.host}:${settings.port}. On a GL.iNet, SSH is on by default; on other OpenWrt routers, turn it on under System → Administration.`
  }
  if (e.code === 'EHOSTUNREACH' || e.code === 'ENETUNREACH' || e.code === 'ETIMEDOUT') {
    return `Cannot reach ${settings.host} from this box. Is the box on the router’s network?`
  }
  return `Could not log in to the router: ${e.message ?? String(err)}`
}
