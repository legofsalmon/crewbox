import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, type App } from '../src/app.ts'
import { lanIps } from '../src/box.ts'
import { openDb } from '../src/db.ts'
import { Store } from '../src/store.ts'
import {
  fingerprint,
  loadRouterDns,
  RouterDnsSync,
  routerScript,
  runOverSsh,
  validTarget,
  type DnsTarget,
  type SshRequest,
  type SshResult,
} from '../src/routerDns.ts'

/**
 * The box logs in to the router as root and rewrites a line of its DNS
 * config. The script is therefore run for real here, in sh, against a fake
 * `uci` and a scratch /etc, and the SSH client against a real SSH server —
 * a router is not the place to find out either one is wrong.
 */

const NAME = 'chat.letissier.ie'

/** A router: a scratch /etc, a `uci` that keeps its address list in a file, and a dnsmasq that counts restarts. */
function fakeRouter() {
  const root = mkdtempSync(join(tmpdir(), 'crewbox-router-'))
  const etc = join(root, 'etc')
  const bin = join(root, 'bin')
  mkdirSync(join(etc, 'init.d'), { recursive: true })
  mkdirSync(join(etc, 'dnsmasq.d'))
  mkdirSync(bin)
  const list = join(root, 'uci-address')
  writeFileSync(list, '')
  // Only the four calls the script makes; anything else fails loudly.
  writeFileSync(
    join(bin, 'uci'),
    `#!/bin/sh
list='${list}'
[ "$1" = -q ] && shift
case "$1" in
  get) tr '\\n' ' ' < "$list" | sed 's/ $//'; echo ;;
  add_list) printf '%s\\n' "\${2#*=}" >> "$list" ;;
  del_list) grep -vxF "\${2#*=}" "$list" > "$list.new"; mv "$list.new" "$list" ;;
  commit) echo commit >> '${root}/commits' ;;
  *) echo "unexpected uci $*" >&2; exit 9 ;;
esac
`
  )
  chmodSync(join(bin, 'uci'), 0o755)
  writeFileSync(join(etc, 'init.d', 'dnsmasq'), `#!/bin/sh\necho "$1" >> '${root}/restarts'\n`)
  chmodSync(join(etc, 'init.d', 'dnsmasq'), 0o755)
  return {
    root,
    etc,
    uci: () => readFileSync(list, 'utf8').split('\n').filter(Boolean),
    setUci: (entries: string[]) => writeFileSync(list, entries.map((e) => `${e}\n`).join('')),
    restarts: () =>
      existsSync(join(root, 'restarts')) ? readFileSync(join(root, 'restarts'), 'utf8') : '',
    run: (target: DnsTarget) =>
      execFileSync('sh', ['-s'], {
        input: routerScript(target, root),
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      }).toString(),
  }
}

describe('the script the router runs', () => {
  let router: ReturnType<typeof fakeRouter>
  beforeEach(() => (router = fakeRouter()))
  afterEach(() => rmSync(router.root, { recursive: true, force: true }))

  it('adds an entry to the dhcp config when there is none anywhere', () => {
    expect(router.run({ hostname: NAME, address: '192.168.200.23' })).toBe('crewbox: updated\n')
    expect(router.uci()).toEqual([`/${NAME}/192.168.200.23`])
    expect(router.restarts()).toBe('restart\n')
  })

  it('moves a stale entry in the dhcp config, leaving the others alone', () => {
    router.setUci(['/printer.lan/192.168.200.5', `/${NAME}/192.168.200.9`])
    expect(router.run({ hostname: NAME, address: '192.168.200.23' })).toBe('crewbox: updated\n')
    expect(router.uci()).toEqual(['/printer.lan/192.168.200.5', `/${NAME}/192.168.200.23`])
  })

  it('fixes an entry typed into a dnsmasq file in place, and adds no second one', () => {
    // Where the downloaded crewbox-dns.conf tells people to put it.
    const file = join(router.etc, 'dnsmasq.d', 'crewbox.conf')
    writeFileSync(file, `# mine\naddress=/${NAME}/10.1.5.113\naddress=/other.example/10.0.0.1\n`)
    expect(router.run({ hostname: NAME, address: '192.168.200.23' })).toBe('crewbox: updated\n')
    expect(readFileSync(file, 'utf8')).toBe(
      `# mine\naddress=/${NAME}/192.168.200.23\naddress=/other.example/10.0.0.1\n`
    )
    expect(router.uci()).toEqual([])
  })

  it('does not match a name that only looks like ours to a regex', () => {
    const file = join(router.etc, 'dnsmasq.conf')
    writeFileSync(file, 'address=/chatxletissier.ie/10.0.0.1\n')
    router.run({ hostname: NAME, address: '192.168.200.23' })
    expect(readFileSync(file, 'utf8')).toBe('address=/chatxletissier.ie/10.0.0.1\n')
  })

  it('changes nothing and restarts nothing when the router is already right', () => {
    router.setUci([`/${NAME}/192.168.200.23`])
    expect(router.run({ hostname: NAME, address: '192.168.200.23' })).toBe('crewbox: unchanged\n')
    expect(router.restarts()).toBe('')
  })

  it('moves the phone probe names only where they were already pointed at a box', () => {
    router.setUci([`/${NAME}/192.168.200.9`, '/captive.apple.com/192.168.200.9'])
    router.run({ hostname: NAME, address: '192.168.200.23' })
    expect(router.uci()).toEqual([`/${NAME}/192.168.200.23`, '/captive.apple.com/192.168.200.23'])
  })

  it('says so on a router with no uci', () => {
    // `command -v` is a builtin, so a PATH with nothing on it hides uci.
    const out = spawnSync('/bin/sh', ['-s'], {
      input: routerScript({ hostname: NAME, address: '192.168.200.23' }, router.root),
      env: { PATH: '/nonexistent' },
    })
    expect(out.stdout.toString()).toBe('crewbox: no uci\n')
    expect(out.status).toBe(3)
  })
})

describe('what may be written into the script', () => {
  it('refuses anything that is not a plain name and an IPv4 address', () => {
    expect(validTarget({ hostname: NAME, address: '192.168.200.23' })).toBe(true)
    for (const target of [
      { hostname: "chat.letissier.ie'; reboot; '", address: '192.168.200.23' },
      { hostname: 'chat.letissier.ie/x', address: '192.168.200.23' },
      { hostname: '*.letissier.ie', address: '192.168.200.23' },
      { hostname: 'localhost', address: '192.168.200.23' },
      { hostname: NAME, address: '192.168.200.256' },
      { hostname: NAME, address: '$(reboot)' },
    ]) {
      expect(validTarget(target)).toBe(false)
      expect(() => routerScript(target)).toThrow()
    }
  })
})

/** A store with just the settings table. */
function memoryStore(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial))
  return {
    getSetting: (key: string) => rows.get(key),
    setSetting: (key: string, value: string) => void rows.set(key, value),
  }
}

const ON = JSON.stringify({ enabled: true, host: '192.168.200.1', password: 'pw' })

describe('when the box logs in to the router', () => {
  function harness(initial: Record<string, string> = { routerDns: ON }) {
    const store = memoryStore(initial)
    const calls: SshRequest[] = []
    let clock = 0
    let target: DnsTarget | null = { hostname: NAME, address: '192.168.200.23' }
    let answer: (req: SshRequest) => Promise<SshResult> = async () => ({
      hostKey: 'SHA256:router',
      stdout: 'crewbox: updated\n',
      stderr: '',
      code: 0,
    })
    const sync = new RouterDnsSync({
      store,
      target: () => target,
      run: (req) => {
        calls.push(req)
        return answer(req)
      },
      now: () => clock,
    })
    return {
      store,
      sync,
      calls,
      moveTo: (address: string) => (target = { hostname: NAME, address }),
      noTarget: () => (target = null),
      answer: (fn: typeof answer) => (answer = fn),
      advance: (ms: number) => (clock += ms),
    }
  }

  it('does nothing at all while it is off', async () => {
    const h = harness({})
    await h.sync.tick()
    expect(h.calls).toHaveLength(0)
    expect(h.sync.status().state).toBe('off')
  })

  it('logs in once, then only again when the address moves', async () => {
    const h = harness()
    await h.sync.tick()
    await h.sync.tick()
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]!.script).toContain("addr='192.168.200.23'")
    expect(h.sync.status()).toMatchObject({ state: 'ok', target: { address: '192.168.200.23' } })

    h.moveTo('192.168.200.40')
    await h.sync.tick()
    expect(h.calls).toHaveLength(2)
    expect(h.calls[1]!.script).toContain("addr='192.168.200.40'")
  })

  it('pins the router key after the first login that works, and sends it after', async () => {
    const h = harness()
    await h.sync.tick()
    expect(loadRouterDns(h.store).hostKey).toBe('SHA256:router')
    h.moveTo('192.168.200.40')
    await h.sync.tick()
    expect(h.calls[1]!.hostKey).toBe('SHA256:router')
  })

  it('does not pin a key when the login failed', async () => {
    const h = harness()
    h.answer(async () => {
      throw Object.assign(new Error('All configured authentication methods failed'), {
        level: 'client-authentication',
      })
    })
    await h.sync.tick()
    expect(loadRouterDns(h.store).hostKey).toBe('')
    expect(h.sync.status()).toMatchObject({ state: 'failed' })
    expect(h.sync.status().message).toMatch(/refused the username or password/)
  })

  it('backs off after a failure instead of hammering the router', async () => {
    const h = harness()
    h.answer(async () => {
      throw Object.assign(new Error('connect'), { code: 'EHOSTUNREACH' })
    })
    await h.sync.tick()
    await h.sync.tick()
    expect(h.calls).toHaveLength(1)
    h.advance(60_000)
    await h.sync.tick()
    expect(h.calls).toHaveLength(2)
    // Doubled the second time.
    h.advance(60_000)
    await h.sync.tick()
    expect(h.calls).toHaveLength(2)
    h.advance(60_000)
    await h.sync.tick()
    expect(h.calls).toHaveLength(3)
  })

  it('tries again straight away when asked, whatever the backoff', async () => {
    const h = harness()
    h.answer(async () => {
      throw Object.assign(new Error('connect'), { code: 'ECONNREFUSED' })
    })
    await h.sync.tick()
    await h.sync.sync()
    expect(h.calls).toHaveLength(2)
    expect(h.sync.status().message).toMatch(/Nothing is accepting SSH/)
  })

  it('reports a router that is not OpenWrt as that, not as a crash', async () => {
    const h = harness()
    h.answer(async () => ({ hostKey: 'k', stdout: 'crewbox: no uci\n', stderr: '', code: 3 }))
    await h.sync.tick()
    expect(h.sync.status().message).toMatch(/not an OpenWrt router/)
  })

  it('waits for a certificate name and an address rather than writing half an entry', async () => {
    const h = harness()
    h.noTarget()
    await h.sync.tick()
    expect(h.calls).toHaveLength(0)
    expect(h.sync.status().state).toBe('failed')
  })

  it('forgets the pinned key when pointed at a different router', () => {
    const h = harness({ routerDns: JSON.stringify({ ...JSON.parse(ON), hostKey: 'SHA256:old' }) })
    h.sync.save({ ...loadRouterDns(h.store), host: '192.168.8.1' })
    expect(loadRouterDns(h.store).hostKey).toBe('')
  })

  it('logs in again after the settings change, even at the same address', async () => {
    const h = harness()
    await h.sync.tick()
    h.sync.save({ ...loadRouterDns(h.store), password: 'new' })
    await h.sync.tick()
    expect(h.calls).toHaveLength(2)
  })
})

describe('the SSH client, against a real SSH server', () => {
  let server: import('ssh2').Server | undefined
  afterEach(() => server?.close())

  async function sshServer(password: string) {
    const { Server, utils } = await import('ssh2')
    const hostKey = utils.generateKeyPairSync('ed25519').private
    const executed: string[] = []
    server = new Server({ hostKeys: [hostKey] }, (client) => {
      client.on('authentication', (ctx) => {
        if (ctx.method === 'password' && ctx.password === password) ctx.accept()
        else ctx.reject(['password'])
      })
      client.on('session', (accept) => {
        accept().on('exec', (acceptExec, _reject, info) => {
          executed.push(info.command)
          const stream = acceptExec()
          const child = spawn('sh', ['-c', info.command])
          stream.pipe(child.stdin)
          child.stdout.pipe(stream, { end: false })
          child.stderr.pipe(stream.stderr, { end: false })
          child.on('close', (code) => {
            stream.exit(code ?? 1)
            stream.end()
          })
        })
      })
      client.on('error', () => {})
    })
    const port = await new Promise<number>((resolve) =>
      server!.listen(0, '127.0.0.1', function (this: { address: () => { port: number } }) {
        resolve(this.address().port)
      })
    )
    return { port, executed }
  }

  const request = (port: number, over: Partial<SshRequest> = {}): SshRequest => ({
    host: '127.0.0.1',
    port,
    username: 'root',
    password: 'right',
    hostKey: '',
    script: "echo 'crewbox: unchanged'\n",
    timeoutMs: 10_000,
    ...over,
  })

  it('pipes the script to sh and reports the key the router presented', async () => {
    const { port, executed } = await sshServer('right')
    const result = await runOverSsh(request(port))
    expect(result.stdout).toBe('crewbox: unchanged\n')
    expect(result.code).toBe(0)
    expect(result.hostKey).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
    // The script travels on stdin, never inside the command line.
    expect(executed).toEqual(['sh -s'])
  })

  it('refuses a router whose key is not the pinned one, before sending the password', async () => {
    const { port, executed } = await sshServer('right')
    await expect(runOverSsh(request(port, { hostKey: 'SHA256:someoneelse' }))).rejects.toThrow(
      'host key mismatch'
    )
    expect(executed).toEqual([])
  })

  it('reports a wrong password as an authentication failure', async () => {
    const { port } = await sshServer('right')
    await expect(runOverSsh(request(port, { password: 'wrong' }))).rejects.toMatchObject({
      level: 'client-authentication',
    })
  })

  it('prints fingerprints the way ssh-keygen does', () => {
    expect(fingerprint(Buffer.from('key'))).toMatch(/^SHA256:[^=]+$/)
  })
})

describe('the admin routes', () => {
  let dir: string
  let app: App | undefined
  const runs: SshRequest[] = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crewbox-router-routes-'))
    runs.length = 0
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
        '1',
        '-subj',
        `/CN=${NAME}`,
      ],
      { stdio: 'ignore' }
    )
  })
  afterEach(async () => {
    await app?.close()
    app = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  const build = () =>
    (app = buildApp({
      store: new Store(openDb(':memory:')),
      eventPin: '9999',
      adminPassword: 'correct-horse',
      filesDir: dir,
      dataDir: dir,
      logger: false,
      routerDnsRun: async (req) => {
        runs.push(req)
        return { hostKey: 'SHA256:router', stdout: 'crewbox: updated\n', stderr: '', code: 0 }
      },
    }))

  const asAdmin = async (method: 'GET' | 'POST', url: string, payload?: object) => {
    const joined = await app!.inject({
      method: 'POST',
      url: '/api/join',
      payload: { name: 'Alex', eventPin: '9999', personalPin: '1234' },
    })
    const { token } = joined.json() as { token: string }
    const unlocked = await app!.inject({
      method: 'POST',
      url: '/api/admin/unlock',
      headers: { authorization: `Bearer ${token}` },
      payload: { password: 'correct-horse' },
    })
    const { adminToken } = unlocked.json() as { adminToken: string }
    return app!.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, 'x-admin-token': adminToken },
      ...(payload ? { payload } : {}),
    })
  }

  it('is off, and says nothing to anyone who is not an admin', async () => {
    build()
    expect((await app!.inject({ method: 'GET', url: '/api/admin/router-dns' })).statusCode).toBe(
      401
    )
    const res = await asAdmin('GET', '/api/admin/router-dns')
    expect(res.json()).toMatchObject({
      enabled: false,
      hasPassword: false,
      status: { state: 'off' },
    })
    expect(runs).toHaveLength(0)
  })

  it('will not turn on without the router’s password', async () => {
    build()
    const res = await asAdmin('POST', '/api/admin/router-dns', {
      enabled: true,
      host: '192.168.200.1',
    })
    expect(res.statusCode).toBe(400)
  })

  it('logs in as soon as it is turned on, and never sends the password back', async () => {
    build()
    const res = await asAdmin('POST', '/api/admin/router-dns', {
      enabled: true,
      host: '192.168.200.1',
      password: 'router-secret',
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain('router-secret')
    const view = res.json() as { hasPassword: boolean; status: { state: string } }
    expect(view.hasPassword).toBe(true)
    if (lanIps()[0]) {
      // A machine with a network address: the entry is this box's name.
      expect(runs).toHaveLength(1)
      expect(runs[0]!.password).toBe('router-secret')
      expect(runs[0]!.script).toContain(`fix '${NAME}' 1`)
      expect(view.status.state).toBe('ok')
    } else {
      expect(view.status.state).toBe('failed')
    }
  })

  it('keeps the saved password when a save leaves it out', async () => {
    build()
    await asAdmin('POST', '/api/admin/router-dns', {
      enabled: true,
      host: '192.168.200.1',
      password: 'router-secret',
    })
    const res = await asAdmin('POST', '/api/admin/router-dns', {
      enabled: true,
      host: '192.168.200.1',
      username: 'root',
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { hasPassword: boolean }).hasPassword).toBe(true)
  })
})
