import { request } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { posterEvent, posterUrls } from '../../deploy/make-poster.mjs'
import { buildApp } from '../src/app.ts'
import { openDb } from '../src/db.ts'
import { joinCode } from '../src/joinCode.ts'
import { Store } from '../src/store.ts'

/**
 * The two QR codes on the printed poster.
 *
 * A poster is the one thing on site that cannot be corrected: it is
 * cable-tied to a pole in the dark on the Thursday and read by four hundred
 * people over the weekend. So the URLs it carries get pinned here rather
 * than trusted.
 */

describe('the URLs on a join poster', () => {
  it('prefills the PIN on the join link, because it is printed alongside anyway', () => {
    expect(posterUrls('https://chat.example.com:8787', '2468').join).toBe(
      'https://chat.example.com:8787/?pin=2468'
    )
  })

  it('escapes a PIN that is not four digits', () => {
    // The runbook tells you to make it long and rotate it once the tunnel is
    // up, and nothing stops a word with a space or an ampersand in it.
    expect(posterUrls('https://chat.example.com', 'load in&out').join).toBe(
      'https://chat.example.com/?pin=load%20in%26out'
    )
  })

  it('keeps the APK link on the same scheme and port as the join link', () => {
    // It used to rewrite https to http, on the theory that Android's
    // installer does not care about TLS. The box cares: one with a
    // certificate serves TLS on that port and nothing else, so the QR was a
    // connection refused — and on a box answering connectivity probes, port
    // 80 *is* answered, by a redirect to the app root that drops the path,
    // so the APK QR landed on the join page instead. Either way the poster
    // was wrong and nobody would find out until a crew member scanned it.
    expect(posterUrls('https://chat.example.com:8787', '2468').apk).toBe(
      'https://chat.example.com:8787/crewbox.apk'
    )
    expect(posterUrls('http://192.168.1.50:8787', '2468').apk).toBe(
      'http://192.168.1.50:8787/crewbox.apk'
    )
  })

  it('does not double the slash when the address was pasted with one', () => {
    const urls = posterUrls('https://chat.example.com:8787/', '2468')
    expect(urls.apk).toBe('https://chat.example.com:8787/crewbox.apk')
    expect(urls.join).toBe('https://chat.example.com:8787/?pin=2468')
  })
})

const EVENT = { id: '0mug582e8ls94xw09hzg6', key: 'B'.repeat(87) }

describe('the event a join poster names', () => {
  it('goes on the join link after the PIN, as the box’s own QR carries it', () => {
    const { join } = posterUrls('http://192.168.8.1:8787', '4821', EVENT)
    expect(join).toBe(`http://192.168.8.1:8787/?pin=4821&event=${EVENT.id}&key=${EVENT.key}`)
    expect(join).toBe(joinCode('http://192.168.8.1:8787', { pin: '4821', event: EVENT }))
    // A PIN with anything in it reads back the same from either.
    const odd = new URL(posterUrls('https://chat.example.com/', 'load in&out', EVENT).join)
    const box = new URL(joinCode('https://chat.example.com', { pin: 'load in&out', event: EVENT }))
    expect([...odd.searchParams]).toEqual([...box.searchParams])
  })

  let app
  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  /**
   * A box listening here, and a fetch that reaches it whatever address a URL
   * gives, as a name in the event's DNS or a port forward would, with that
   * address as the Host header.
   */
  async function aBox() {
    app = buildApp({ store: new Store(openDb(':memory:')), eventPin: '4821', logger: false })
    await app.listen({ host: '127.0.0.1', port: 0 })
    const { port } = app.server.address()
    const config = (await app.inject({ url: '/api/config' })).json()
    const fetch = (url, init) =>
      new Promise((resolve, reject) => {
        const { host, pathname, search } = new URL(url)
        const req = request(
          {
            host: '127.0.0.1',
            port,
            path: `${pathname}${search}`,
            headers: { host },
            signal: init?.signal,
          },
          (res) => {
            const chunks = []
            res.on('data', (chunk) => chunks.push(chunk))
            res.on('end', () =>
              resolve(new Response(Buffer.concat(chunks), { status: res.statusCode }))
            )
          }
        )
        req.on('error', reject)
        req.end()
      })
    return { port, event: { id: config.eventId, key: config.eventKey }, fetch }
  }

  it('is the event of a box that signs for the poster’s address', async () => {
    const { port, event, fetch } = await aBox()
    expect(await posterEvent(`http://127.0.0.1:${port}/`, { fetch })).toEqual({
      event,
      signed: true,
    })
  })

  it('is named by a name the box has no certificate for, where the apps check the sign-in', async () => {
    const { event, fetch } = await aBox()
    expect(await posterEvent('http://crewbox.local:8787', { fetch })).toEqual({
      event,
      signed: false,
    })
  })

  it('is left off at an address the box won’t sign for, as a port forward’s', async () => {
    const { fetch } = await aBox()
    // A documentation address: the box, reached there, is not at its own.
    const { event, why } = await posterEvent('http://192.0.2.1:8787', { fetch })
    expect(event).toBeUndefined()
    expect(why).toMatch(/^the box won't sign for 192\.0\.2\.1:8787, which isn't its own address/)
  })

  it('is left off when nothing answers, the box gives no key, or what answers doesn’t prove it', async () => {
    const { port, event, fetch } = await aBox()
    const url = `http://127.0.0.1:${port}`
    const nothing = () =>
      Promise.reject(new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') }))
    expect(await posterEvent(url, { fetch: nothing })).toEqual({
      why: `nothing answered at ${url} (connect ECONNREFUSED)`,
    })

    const answering =
      (identity, config = { eventId: event.id, eventKey: event.key }) =>
      (asked) =>
        Promise.resolve(
          new URL(asked).pathname === '/api/config'
            ? Response.json(config)
            : typeof identity === 'number'
              ? new Response('', { status: identity })
              : Response.json(identity)
        )
    expect((await posterEvent(url, { fetch: answering(200, { eventId: event.id }) })).why).toBe(
      `what answered at 127.0.0.1:${port} gives no event key: a box from before this version, or not a box`
    )
    const aRouter = () => Promise.resolve(new Response('<html>Router login</html>'))
    expect((await posterEvent(url, { fetch: aRouter })).why).toMatch(/gives no event key/)
    for (const [what, identity] of [
      ['a box too old to sign', 404],
      [
        'a signature that isn’t the key’s',
        { eventId: event.id, key: event.key, signature: 'A'.repeat(86) },
      ],
      ['another event', { eventId: 'saturday', key: event.key, signature: 'A'.repeat(86) }],
      ['no signature', { eventId: event.id, key: event.key }],
    ]) {
      const { event: named, why } = await posterEvent(url, { fetch: answering(identity) })
      expect(named, what).toBeUndefined()
      expect(why, what).toMatch(/^(the box at|what answered at) 127\.0\.0\.1:\d+/)
    }
    // The real box's answer, passed on for another address, doesn't prove it either.
    const relayed = async (asked, init) => {
      const at = new URL(asked)
      at.host = `127.0.0.1:${port}`
      return fetch(at.href, init)
    }
    expect((await posterEvent('http://10.0.0.66:8787', { fetch: relayed })).why).toBe(
      "what answered at 10.0.0.66:8787 didn't prove it runs the event it names"
    )
  })
})
