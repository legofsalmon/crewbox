import { networkInterfaces } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import QRCode from 'qrcode-svg'
import { buildApp, type App } from '../src/app.ts'
import { openDb } from '../src/db.ts'
import { Store } from '../src/store.ts'
import { joinCode, namesEventAt } from '../src/joinCode.ts'

/**
 * The join QR (docs/DISCOVERY.md, "The join QR"): the box's address, the
 * event PIN where whoever reads it may be shown it, and the event's ID and
 * public key, which the apps' scanner checks the box at that address against
 * before the PIN goes to it. web/src/lib/joinCode.test.ts reads it back, and
 * e2e/scan.spec.ts joins with the one `/connect` prints.
 */

const EVENT = '0mug582e8ls94xw09hzg6'
const KEY =
  'BBuVbRM8Sw6ywPD2sM35VyQ_clMVJITQeLbmoD9NOiWbRTujpujjBYFvhsuGAZ9pl2H4mLPL6OFxcs9MlgzIYaQ'

describe('the join QR', () => {
  it('is the box’s address, the event PIN, and the event with its key', () => {
    const code = new URL(
      joinCode('http://192.168.8.1:8787', { pin: '4821', event: { id: EVENT, key: KEY } })
    )
    expect(`${code.origin}${code.pathname}`).toBe('http://192.168.8.1:8787/')
    expect([...code.searchParams]).toEqual([
      ['pin', '4821'],
      ['event', EVENT],
      ['key', KEY],
    ])
  })

  it('names the event where it leaves the PIN out', () => {
    const code = new URL(joinCode('https://chat.crew.example', { event: { id: EVENT, key: KEY } }))
    expect(code.origin).toBe('https://chat.crew.example')
    expect([...code.searchParams]).toEqual([
      ['event', EVENT],
      ['key', KEY],
    ])
  })

  it('carries a PIN with anything in it as it was set', () => {
    const pin = 'a b&c=d#e?+%'
    const code = new URL(joinCode('http://10.0.0.2', { pin, event: { id: EVENT, key: KEY } }))
    expect(code.searchParams.get('pin')).toBe(pin)
    expect(code.searchParams.get('event')).toBe(EVENT)
    expect(code.hash).toBe('')
  })

  it('is the address and PIN alone where it names no event', () => {
    expect(joinCode('http://203.0.113.7:8787', { pin: '4821' })).toBe(
      'http://203.0.113.7:8787/?pin=4821'
    )
  })
})

describe('where the join QR names the event', () => {
  // As os.networkInterfaces() gives them.
  const box = {
    lo: [{ address: '127.0.0.1' }, { address: '::1' }],
    wlan0: [{ address: '192.168.8.1' }, { address: 'fd00:0:0:0::8' }, { address: 'fe80::8%wlan0' }],
  }

  it('names it at the box’s own addresses, which it signs for', () => {
    for (const base of [
      'http://192.168.8.1:8787',
      'https://192.168.8.1',
      'http://[fd00::8]:8787',
      'http://[FD00:0000::8]:8787',
    ]) {
      expect(namesEventAt(base, box), base).toBe(true)
    }
  })

  it('names it by a name, where the apps take the sign-in to check', () => {
    for (const base of ['http://crewbox.local:8787', 'https://chat.crew.example']) {
      expect(namesEventAt(base, box), base).toBe(true)
    }
  })

  it('leaves it out at an address that isn’t the box’s, as a port forward’s', () => {
    // The box never signs there, and the apps would refuse a poster that
    // named its event at an IP address its box won't sign for.
    for (const base of [
      'http://203.0.113.7:8787',
      'http://192.168.8.10:8787',
      'http://[fd00::9]',
    ]) {
      expect(namesEventAt(base, box), base).toBe(false)
    }
    expect(namesEventAt('http://192.168.8.1:8787', {})).toBe(false)
  })
})

describe('the poster at /connect', () => {
  const apps: App[] = []
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close()
  })

  const newApp = (trustProxy = false) => {
    const store = new Store(openDb(':memory:'))
    const app = buildApp({ store, eventPin: '4821', logger: false, trustProxy })
    apps.push(app)
    return app
  }

  /**
   * The link printed under the QR, and the QR drawn above it: its size in
   * the SVG's units, and where its dark modules are. The page draws one unit
   * a module inside a margin of two, each module a square of its own in one
   * path (qrcode-svg's `join`).
   */
  function poster(html: string) {
    const href = /<p class="url"><a href="([^"]+)">/.exec(html)?.[1]
    const svg = /<div class="qr">(<svg[\s\S]*?<\/svg>)<\/div>/.exec(html)?.[1]
    expect(href, 'the link under the QR').toBeDefined()
    expect(svg, 'the QR').toBeDefined()
    const [, width, height] = /viewBox="0 0 (\d+) (\d+)"/.exec(svg!) ?? []
    const path = /<path [^>]*\bd="([^"]*)"/.exec(svg!)?.[1] ?? ''
    const dark = new Set(
      [...path.matchAll(/M(\d+),(\d+) V(\d+) H(\d+)/g)].map(([, x, y, bottom, right]) => {
        // Every square one unit across.
        expect(Number(bottom) - Number(y)).toBe(1)
        expect(Number(right) - Number(x)).toBe(1)
        return `${Number(x) - 2},${Number(y) - 2}`
      })
    )
    return {
      link: href!.replaceAll('&amp;', '&'),
      width: Number(width),
      height: Number(height),
      dark,
    }
  }

  /** The modules of a QR of `text`, as qrcode-svg makes it for the page. */
  function qrOf(text: string) {
    const model = new QRCode({ content: text }).qrcode
    const count = model.getModuleCount()
    const dark = new Set<string>()
    for (let x = 0; x < count; x++) {
      for (let y = 0; y < count; y++) if (model.isDark(x, y)) dark.add(`${x},${y}`)
    }
    return { count, dark }
  }

  it('draws the link printed under it, which names the event and its key', async () => {
    const app = newApp()
    const config = (await app.inject({ url: '/api/config' })).json() as {
      eventId: string
      eventKey: string
    }
    const res = await app.inject({ url: '/connect', remoteAddress: '192.168.1.50' })
    const { link, width, height, dark } = poster(res.body)
    const url = new URL(link)
    expect(url.pathname).toBe('/')
    expect([...url.searchParams]).toEqual([
      ['pin', '4821'],
      ['event', config.eventId],
      ['key', config.eventKey],
    ])
    const drawn = qrOf(link)
    expect(width).toBe(drawn.count + 4)
    expect(height).toBe(width)
    expect(dark).toEqual(drawn.dark)
  })

  it('names the event off the LAN too, where it leaves the PIN out', async () => {
    const app = newApp(true)
    const config = (await app.inject({ url: '/api/config' })).json() as {
      eventId: string
      eventKey: string
    }
    const res = await app.inject({
      url: '/connect',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.7' },
    })
    const { link, dark } = poster(res.body)
    expect([...new URL(link).searchParams]).toEqual([
      ['event', config.eventId],
      ['key', config.eventKey],
    ])
    expect(dark).toEqual(qrOf(link).dark)
  })

  it('names the event by a name, and not at an address that isn’t the box’s', async () => {
    const app = newApp()
    const config = (await app.inject({ url: '/api/config' })).json() as {
      eventId: string
      eventKey: string
    }
    const at = async (host: string) => {
      const res = await app.inject({
        url: '/connect',
        remoteAddress: '192.168.1.50',
        headers: { host },
      })
      const { link, dark } = poster(res.body)
      expect(dark, host).toEqual(qrOf(link).dark)
      return new URL(link)
    }
    const named = await at('crewbox.local:8787')
    expect(named.origin).toBe('http://crewbox.local:8787')
    expect([...named.searchParams]).toEqual([
      ['pin', '4821'],
      ['event', config.eventId],
      ['key', config.eventKey],
    ])
    // An address this machine doesn't have: a port forward's, where the box
    // won't sign. (Some sandboxes run on documentation addresses.)
    const own = Object.values(networkInterfaces()).flatMap((list) =>
      (list ?? []).map(({ address }) => address)
    )
    const elsewhere = ['198.51.100.7', '203.0.113.7', '192.0.2.77'].find((ip) => !own.includes(ip))!
    const forwarded = await at(`${elsewhere}:8787`)
    expect(forwarded.origin).toBe(`http://${elsewhere}:8787`)
    expect([...forwarded.searchParams]).toEqual([['pin', '4821']])
  })
})
