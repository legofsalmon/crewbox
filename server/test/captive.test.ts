import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import {
  captiveResponse,
  FALLBACK_PORT,
  PROBE_HOSTS,
  shouldFallBack,
  startCaptive,
} from '../src/captive.ts'

/**
 * The probe responder. The bodies here are not "a reasonable answer" — they
 * are the exact bytes each OS compares against, and a phone that gets
 * anything else decides the network is a captive portal, pops a sign-in
 * sheet crew cannot complete, and (on iOS) leaves for cellular anyway. So
 * these read as literals on purpose: a refactor that "tidies" one of them
 * should fail here rather than on site.
 */

const ORIGIN = 'https://chat.example.ie:8787'

describe('what each OS is told', () => {
  it('gives Apple the Success page it looks for', () => {
    const reply = captiveResponse('/hotspot-detect.html', ORIGIN)
    expect(reply.status).toBe(200)
    expect(reply.type).toBe('text/html')
    expect(reply.body).toContain('Success')
  })

  it('answers the older Apple path too, which tvOS and some macOS builds use', () => {
    expect(captiveResponse('/library/test/success.html', ORIGIN).status).toBe(200)
  })

  it('gives Android a bare 204 — a body would read as a portal', () => {
    for (const path of ['/generate_204', '/gen_204']) {
      const reply = captiveResponse(path, ORIGIN)
      expect(reply.status).toBe(204)
      expect(reply.body).toBeUndefined()
    }
  })

  it('gives Windows both NCSI strings verbatim', () => {
    expect(captiveResponse('/connecttest.txt', ORIGIN).body).toBe('Microsoft Connect Test')
    expect(captiveResponse('/ncsi.txt', ORIGIN).body).toBe('Microsoft NCSI')
  })

  it('gives Firefox its success.txt', () => {
    expect(captiveResponse('/success.txt', ORIGIN).body).toBe('success\n')
  })

  it('ignores a query string, since a browser may add one', () => {
    expect(captiveResponse('/generate_204?t=17', ORIGIN).status).toBe(204)
  })
})

describe('anything that is not a probe', () => {
  it('sends a person to the box — the case of typing the name without https', () => {
    const reply = captiveResponse('/', ORIGIN)
    expect(reply.status).toBe(302)
    expect(reply.location).toBe(ORIGIN)
  })

  it('never redirects anywhere the request asked for', () => {
    // The origin is computed at startup from this box's own certificate and
    // port. Nothing in the request reaches it, so a responder on an event
    // network cannot be used to bounce anyone to an attacker's site.
    for (const path of [
      '//evil.example.com/',
      '/https://evil.example.com',
      '/redirect?to=https://evil.example.com',
      '/\\evil.example.com',
    ]) {
      expect(captiveResponse(path, ORIGIN).location).toBe(ORIGIN)
    }
  })
})

describe('which hostnames it is worth pointing here', () => {
  it('leaves out the names that serve real content as well as a probe', () => {
    // Hijacking these breaks pages instead of fixing a network, and
    // dns.msftncsi.com is a DNS probe whose answer we would get wrong.
    for (const host of ['www.google.com', 'www.gstatic.com', 'dns.msftncsi.com']) {
      expect(PROBE_HOSTS).not.toContain(host)
    }
  })

  it('covers the four platforms crew actually carry', () => {
    expect(PROBE_HOSTS).toContain('captive.apple.com')
    expect(PROBE_HOSTS).toContain('connectivitycheck.gstatic.com')
    expect(PROBE_HOSTS).toContain('www.msftconnecttest.com')
    expect(PROBE_HOSTS).toContain('detectportal.firefox.com')
  })
})

describe('the listener', () => {
  it('answers a real request, on an ephemeral port', async () => {
    const { portal, reason } = await startCaptive({ host: '127.0.0.1', port: 0, origin: ORIGIN })
    expect(reason).toBeUndefined()
    expect(portal).toBeDefined()
    const base = `http://127.0.0.1:${portal?.port}`

    const apple = await fetch(`${base}/hotspot-detect.html`)
    expect(apple.status).toBe(200)
    expect(await apple.text()).toContain('Success')
    // A cached Success would outlive the network it was true for.
    expect(apple.headers.get('cache-control')).toBe('no-store')

    const android = await fetch(`${base}/generate_204`)
    expect(android.status).toBe(204)
    expect(await android.text()).toBe('')

    const person = await fetch(`${base}/`, { redirect: 'manual' })
    expect(person.status).toBe(302)
    expect(person.headers.get('location')).toBe(ORIGIN)

    // Nothing here has a side effect, so nothing needs to accept a write.
    const post = await fetch(`${base}/generate_204`, { method: 'POST' })
    expect(post.status).toBe(405)

    await portal?.close()
  })

  it('reports the port it got, and that it was the one asked for', async () => {
    const { portal } = await startCaptive({ host: '127.0.0.1', port: 0, origin: ORIGIN })
    expect(portal?.fallback).toBe(false)
    await portal?.close()
  })

  it('fails soft when the port is taken, naming what to do', async () => {
    // The box must still serve crew when it cannot have port 80 — same
    // posture as a missing certificate.
    const squatter = createServer()
    await new Promise<void>((done) => squatter.listen(0, '127.0.0.1', done))
    const address = squatter.address()
    const held = typeof address === 'object' && address ? address.port : 0

    const { portal, reason } = await startCaptive({ host: '127.0.0.1', port: held, origin: ORIGIN })
    expect(portal).toBeUndefined()
    expect(reason).toMatch(/already listening/)
    expect(reason).toMatch(/CREWBOX_CAPTIVE_PORT/)

    await new Promise<void>((done) => squatter.close(() => done()))
  })
})

describe('when port 80 needs a privilege the box has not got', () => {
  /**
   * A double-clicked Crewbox.app runs as whoever launched it, so this is the
   * ordinary macOS outcome, not an edge case. Giving up would mean the
   * feature never works on the platform most boxes run on.
   *
   * The decision is tested directly because the condition that triggers it —
   * EACCES on a privileged bind — cannot be produced by a test that might be
   * running as root, which CI containers frequently are.
   */
  it('steps aside for a privilege failure', () => {
    expect(shouldFallBack('EACCES', { port: 80 })).toBe(true)
  })

  it('does not step aside when something else holds the port', () => {
    // Moving to another port would not help: whatever is answering on 80
    // will keep answering the probes, and answering them wrongly.
    expect(shouldFallBack('EADDRINUSE', { port: 80 })).toBe(false)
    expect(shouldFallBack(undefined, { port: 80 })).toBe(false)
  })

  it('honours a port the operator named', () => {
    // CREWBOX_CAPTIVE_PORT is a promise something has already been built
    // around — a router forward, a pf rule. Quietly using a different port
    // would break that arrangement without saying so.
    expect(shouldFallBack('EACCES', { port: 8080, portFromEnv: true })).toBe(false)
  })

  it('does not loop when the fallback port is the one that failed', () => {
    expect(shouldFallBack('EACCES', { port: FALLBACK_PORT })).toBe(false)
  })

  // The real socket path, when the test process is unprivileged enough to
  // produce EACCES. Skipped rather than silently passing as root, so the
  // output says which of the two happened.
  const asRoot = process.getuid?.() === 0
  it.skipIf(asRoot)('really lands on the fallback port, answering', async () => {
    // Port 1 is privileged everywhere crewbox runs, so an unprivileged run
    // gets a genuine EACCES rather than a simulated one.
    const { portal, reason } = await startCaptive({ host: '127.0.0.1', port: 1, origin: ORIGIN })
    expect(reason).toBeUndefined()
    expect(portal?.port).toBe(FALLBACK_PORT)
    expect(portal?.fallback).toBe(true)
    const res = await fetch(`http://127.0.0.1:${FALLBACK_PORT}/generate_204`)
    expect(res.status).toBe(204)
    await portal?.close()
  })
})
