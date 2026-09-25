// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../store.ts'
import { forgetEventRecord, knownEvents } from '../lib/eventScope.ts'
import { resetSearchForTests } from '../lib/discovery.ts'
import { clearJoinLink, receiveLink } from '../lib/appLinks.ts'
import type {
  ScanOutcome,
  ScannerPlugin,
  WifiNetwork,
  WifiOutcome,
  WifiPlugin,
} from '../lib/server.ts'
import Join from './Join.tsx'

/**
 * The join screen's scanner, in the apps.
 *
 * The join poster's QR is the box's address with the event PIN, and scanning
 * it fills in both, as if they had been typed. Since the QR has also named
 * the event and its key, Join first checks the box at that address is the
 * poster's (the store's join, tested in events.test.ts); a poster printed
 * before then joins as a typed address does. A Wi-Fi code asks the phone to
 * join its network, which the phone asks the crew member about. Anything else
 * the camera reads fills in nothing and says what it was.
 */

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

let root: Root
let host: HTMLElement
let answer: () => Promise<ScanOutcome>
const openSettings = vi.fn(async () => {})
const join = vi.fn(async () => {})
let joined: (network: WifiNetwork) => Promise<WifiOutcome>
const joinWifi = vi.fn((network: WifiNetwork) => joined(network))

function inApp(platform: 'android' | 'ios', scanner = true, wifi = true): void {
  const plugin: ScannerPlugin = { scan: () => answer(), openSettings }
  const wifiPlugin: WifiPlugin = { join: joinWifi }
  window.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => platform,
    Plugins: {
      ...(scanner ? { CrewboxScanner: plugin } : {}),
      ...(wifi ? { CrewboxWifi: wifiPlugin } : {}),
    },
  }
}

/** What the phone says to joining a network from now on. */
const wifiGives = (outcome: WifiOutcome) => {
  joined = async () => outcome
}

const scans = (outcome: ScanOutcome) => {
  answer = async () => outcome
}
const reads = (text: string) => scans({ result: 'scanned', text })

async function render(): Promise<void> {
  await act(async () => {
    root.render(<Join />)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
const button = (name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent === name)
const field = (placeholder: string) =>
  host.querySelector<HTMLInputElement>(`input[placeholder^="${placeholder}"]`)!
const server = () => field('e.g. chat')
const eventPin = () => field('On the join poster')
const error = () => host.querySelector('.join-error')?.textContent ?? null
const note = () => host.querySelector('.join-scan-note')?.textContent ?? null
async function tap(el: HTMLElement | undefined): Promise<void> {
  expect(el).toBeDefined()
  await act(async () => {
    el!.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
const scan = () => tap(button('Scan the join poster'))
/** Types into a field as React sees it: through the value setter, then input. */
function type(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  for (const event of knownEvents()) forgetEventRecord(event.id)
  localStorage.clear()
  answer = async () => ({ result: 'cancelled' })
  openSettings.mockClear()
  join.mockClear()
  clearJoinLink()
  joined = async () => ({ result: 'declined' })
  joinWifi.mockClear()
  useStore.setState({ join })
  document.body.innerHTML = ''
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  resetSearchForTests()
  delete window.Capacitor
  localStorage.clear()
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined
})

describe('where the scanner is offered', () => {
  it('is not in a browser, which is at its box already', async () => {
    await render()
    expect(button('Scan the join poster')).toBeUndefined()
  })

  it('is not in an app without a scanner', async () => {
    inApp('android', false)
    await render()
    expect(button('Scan the join poster')).toBeUndefined()
    expect(server()).not.toBeNull()
  })

  it('is in either app that has one', async () => {
    for (const platform of ['android', 'ios'] as const) {
      inApp(platform)
      await render()
      expect(button('Scan the join poster'), platform).toBeDefined()
      act(() => root.unmount())
      root = createRoot(host)
    }
  })
})

describe('scanning the join poster', () => {
  it('fills in the box’s address and the event PIN, then asks for a name', async () => {
    inApp('android')
    await render()
    reads('http://192.168.8.1/?pin=4821')

    await scan()

    expect(server().value).toBe('192.168.8.1')
    expect(eventPin().value).toBe('4821')
    expect(note()).toBe('Filled in 192.168.8.1 and the event PIN from the poster.')
    expect(error()).toBeNull()
    expect(document.activeElement?.getAttribute('placeholder')).toBe('e.g. Alex (Stage 2)')
  })

  it('keeps https:// for a box reached by the name on its certificate', async () => {
    inApp('ios')
    await render()
    reads('https://chat.crew.example/')

    await scan()

    expect(server().value).toBe('https://chat.crew.example')
    expect(eventPin().value).toBe('')
    expect(note()).toBe('Filled in chat.crew.example. The event PIN is on the join poster.')
  })

  it('joins at the scanned box with the scanned PIN', async () => {
    inApp('android')
    await render()
    reads('http://10.0.0.2:3000/?pin=4821')
    await scan()
    type(field('e.g. Alex'), 'Alex')
    type(field('4–8 digits'), '1234')

    await act(async () => {
      host.querySelector('form')!.requestSubmit()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(join).toHaveBeenCalledWith('Alex', '4821', '1234')
    expect(localStorage.getItem('crewbox:server-url')).toBe('http://10.0.0.2:3000')
  })

  const EVENT = '0mug582e8ls94xw09hzg6'
  const KEY =
    'BBuVbRM8Sw6ywPD2sM35VyQ_clMVJITQeLbmoD9NOiWbRTujpujjBYFvhsuGAZ9pl2H4mLPL6OFxcs9MlgzIYaQ'
  const NAMING = `event=${EVENT}&key=${KEY}`

  /** A name and a personal PIN, then Join. */
  async function joinAsAlex(): Promise<void> {
    type(field('e.g. Alex'), 'Alex')
    type(field('4–8 digits'), '1234')
    await act(async () => {
      host.querySelector('form')!.requestSubmit()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }

  it('has Join check the box is the poster’s, when the poster names its event', async () => {
    for (const [code, platform] of [
      [`http://10.0.0.2:3000/?pin=4821&${NAMING}`, 'android'],
      [`http://192.168.8.1/?pin=4821&${NAMING}`, 'ios'],
      [`https://chat.crew.example/?${NAMING}`, 'ios'],
    ] as const) {
      inApp(platform)
      await render()
      reads(code)
      await scan()
      type(eventPin(), '4821')
      await joinAsAlex()
      expect(join, code).toHaveBeenLastCalledWith('Alex', '4821', '1234', { id: EVENT, key: KEY })
      act(() => root.unmount())
      root = createRoot(host)
    }
  })

  it('joins as typed once the address is typed over, even with the poster’s again', async () => {
    inApp('android')
    await render()
    reads(`http://10.0.0.2:3000/?pin=4821&${NAMING}`)
    await scan()
    type(server(), '10.0.0.9:3000')
    await joinAsAlex()
    expect(join).toHaveBeenLastCalledWith('Alex', '4821', '1234')
    // Somebody sure of the box, past a poster that doesn't match it.
    type(server(), '10.0.0.2:3000')
    await joinAsAlex()
    expect(join).toHaveBeenLastCalledWith('Alex', '4821', '1234')
  })

  it('joins as typed from a poster printed before the QR named the event', async () => {
    inApp('android')
    await render()
    reads(`http://10.0.0.2:3000/?pin=4821&${NAMING}`)
    await scan()
    // Then the older poster by the door, for the same box.
    reads('http://10.0.0.2:3000/?pin=4821')
    await scan()
    await joinAsAlex()
    expect(join).toHaveBeenLastCalledWith('Alex', '4821', '1234')
  })

  it('joins as typed from a link followed after the scan, which vouches for nothing', async () => {
    inApp('android')
    await render()
    reads(`http://10.0.0.2:3000/?pin=4821&${NAMING}`)
    await scan()
    await act(async () => {
      receiveLink('crewbox://join?server=10.0.0.2:3000&pin=4821')
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(note()).toBe('Filled in 10.0.0.2:3000 and the event PIN from the link.')
    await joinAsAlex()
    expect(join).toHaveBeenLastCalledWith('Alex', '4821', '1234')
  })

  it('says a plain-HTTP name won’t work on an iPhone, as a typed one would', async () => {
    inApp('ios')
    await render()
    reads('http://crew.example.org/?pin=4821')

    await scan()

    expect(server().value).toBe('crew.example.org')
    expect(error()).toContain('An iPhone only connects to a name like crew.example.org over HTTPS')
    expect(note()).toBeNull()
  })
})

describe('a Wi-Fi code', () => {
  const CREW_NET = 'WIFI:T:WPA;S:Crew Net;P:backstage;;'

  it('asks the phone to join its network, then says to scan the crew code', async () => {
    inApp('ios')
    await render()
    reads(CREW_NET)
    wifiGives({ result: 'joined' })

    await scan()

    expect(joinWifi).toHaveBeenCalledExactlyOnceWith({
      ssid: 'Crew Net',
      password: 'backstage',
      wpa3: false,
      hidden: false,
    })
    expect(note()).toBe('On Crew Net. Now scan the crew code on the join poster.')
    expect(error()).toBeNull()
    expect(server().value).toBe('')

    // Which is the next scan.
    reads('http://192.168.8.1/?pin=4821')
    await scan()
    expect(note()).toBe('Filled in 192.168.8.1 and the event PIN from the poster.')
    expect(joinWifi).toHaveBeenCalledOnce()
  })

  it('passes on WPA3 alone and a hidden network, as the code says', async () => {
    inApp('android')
    await render()
    reads('WIFI:T:SAE;S:Crew Net;P:backstage;H:true;;')
    wifiGives({ result: 'saved' })

    await scan()

    expect(joinWifi).toHaveBeenCalledExactlyOnceWith({
      ssid: 'Crew Net',
      password: 'backstage',
      wpa3: true,
      hidden: true,
    })
  })

  it('says what the phone did with it', async () => {
    const said: [WifiOutcome, 'note' | 'error', string][] = [
      [
        { result: 'saved' },
        'note',
        'Saved Crew Net, and the phone is joining it. Now scan the crew code on the join poster.',
      ],
      [
        { result: 'known' },
        'note',
        'This phone already has Crew Net saved. If it isn’t on it, pick it in the phone’s ' +
          'Wi-Fi settings, then scan the crew code on the join poster.',
      ],
      [
        { result: 'declined' },
        'error',
        'The app didn’t join Crew Net. Join it in the phone’s Wi-Fi settings, then scan the ' +
          'crew code on the join poster.',
      ],
      [
        { result: 'failed' },
        'error',
        'The phone saved Crew Net but doesn’t seem to be on it. If it’s in range, check the ' +
          'password in the phone’s Wi-Fi settings, then scan the crew code on the join poster.',
      ],
      [
        { result: 'invalid' },
        'error',
        'The phone can’t use that Wi-Fi code: the name or password in it isn’t valid. Join ' +
          'Crew Net in the phone’s Wi-Fi settings, then scan the crew code on the join poster.',
      ],
      [
        { result: 'unavailable' },
        'error',
        'That code is for the Wi-Fi, Crew Net. Join it with this phone’s camera or its Wi-Fi ' +
          'settings, then scan the crew code on the join poster.',
      ],
    ]
    inApp('android')
    await render()
    reads(CREW_NET)
    for (const [outcome, where, text] of said) {
      wifiGives(outcome)
      await scan()
      expect(where === 'note' ? note() : error(), outcome.result).toBe(text)
      expect(where === 'note' ? error() : note(), outcome.result).toBeNull()
    }
    expect(joinWifi).toHaveBeenCalledTimes(said.length)
  })

  it('says “Joining the Wi-Fi…” until the phone answers', async () => {
    inApp('ios')
    await render()
    reads(CREW_NET)
    let answer!: (outcome: WifiOutcome) => void
    joined = () => new Promise((resolve) => (answer = resolve))

    await scan()

    const busy = button('Joining the Wi-Fi…')
    expect(busy?.disabled).toBe(true)
    await act(async () => {
      answer({ result: 'joined' })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(button('Scan the join poster')?.disabled).toBe(false)
    expect(note()).toBe('On Crew Net. Now scan the crew code on the join poster.')
  })

  it('doesn’t trouble the phone with a code it couldn’t use', async () => {
    inApp('android')
    await render()

    // A WPA password is 8 characters at least.
    reads('WIFI:T:WPA;S:Crew Net;P:back;;')
    await scan()
    expect(error()).toBe(
      'The phone can’t use that Wi-Fi code: the name or password in it isn’t valid. Join ' +
        'Crew Net in the phone’s Wi-Fi settings, then scan the crew code on the join poster.'
    )

    reads('WIFI:T:WPA;P:backstage;;')
    await scan()
    expect(error()).toBe(
      'The phone can’t use that Wi-Fi code: the name or password in it isn’t valid. Join ' +
        'the crew Wi-Fi in the phone’s settings, then scan the crew code on the join poster.'
    )
    expect(joinWifi).not.toHaveBeenCalled()
  })

  it('leaves WEP, enterprise networks and a key in hex to the phone’s settings', async () => {
    inApp('ios')
    await render()
    for (const code of [
      'WIFI:T:WEP;S:Crew Net;P:0123456789;;',
      'WIFI:T:WPA2-EAP;S:Crew Net;E:PEAP;I:tech;P:backstage;;',
      `WIFI:T:WPA;S:Crew Net;P:${'0123456789abcdef'.repeat(4)};;`,
    ]) {
      reads(code)
      await scan()
      expect(error(), code).toBe(
        'That code is for the Wi-Fi, Crew Net, which the app can’t join. Join it in the ' +
          'phone’s Wi-Fi settings, then scan the crew code on the join poster.'
      )
    }
    expect(joinWifi).not.toHaveBeenCalled()
  })

  it('names the network, and fills in nothing, where the app can’t join it', async () => {
    inApp('android', true, false)
    await render()
    reads(CREW_NET)

    await scan()

    expect(server().value).toBe('')
    expect(error()).toBe(
      'That code is for the Wi-Fi, Crew Net. Join it with this phone’s camera or its Wi-Fi ' +
        'settings, then scan the crew code on the join poster.'
    )
  })

  it('says the same when asking the phone fails, or it answers something new', async () => {
    const same =
      'That code is for the Wi-Fi, Crew Net. Join it with this phone’s camera or its Wi-Fi ' +
      'settings, then scan the crew code on the join poster.'
    inApp('ios')
    await render()
    reads(CREW_NET)
    joined = async () => {
      throw new Error('bridge gone')
    }

    await scan()

    expect(error()).toBe(same)
    expect(button('Scan the join poster')?.disabled).toBe(false)

    // A later app's native side, with an answer this page doesn't know.
    wifiGives({ result: 'queued' } as unknown as WifiOutcome)
    reads(CREW_NET)
    await scan()

    expect(error()).toBe(same)
    expect(joinWifi).toHaveBeenCalledTimes(2)
  })
})

describe('what else the camera might read', () => {
  it('says anything else isn’t the crew code', async () => {
    inApp('android')
    await render()
    reads('https://example.com/menu')

    await scan()

    expect(server().value).toBe('')
    expect(eventPin().value).toBe('')
    expect(error()).toBe(
      'That isn’t the crew code. Scan the QR on the join poster, or type the address under it.'
    )
  })
})

describe('when the scan does not happen', () => {
  it('leaves everything as it was when backed out of', async () => {
    inApp('android')
    await render()
    reads('http://192.168.8.1/?pin=4821')
    await scan()
    scans({ result: 'cancelled' })

    await scan()

    expect(server().value).toBe('192.168.8.1')
    expect(error()).toBeNull()
  })

  it('points to Settings when the camera isn’t allowed', async () => {
    inApp('ios')
    await render()
    scans({ result: 'denied' })

    await scan()

    expect(error()).toContain('Switch on Camera for Crewbox in Settings')
    await tap(button('Open Settings'))
    expect(openSettings).toHaveBeenCalledOnce()

    // A scan that works puts the way to Settings away.
    reads('http://192.168.8.1/?pin=4821')
    await scan()
    expect(button('Open Settings')).toBeUndefined()
  })

  it('says a phone that can’t scan should type the address', async () => {
    inApp('android')
    await render()
    scans({ result: 'unavailable' })

    await scan()

    expect(error()).toBe('This phone can’t scan codes. Type the address from the join poster.')
    expect(button('Open Settings')).toBeUndefined()
  })

  it('says the camera didn’t start when the scanner fails', async () => {
    inApp('android')
    await render()
    answer = async () => {
      throw new Error('camera in use')
    }

    await scan()

    expect(error()).toBe(
      'The camera didn’t start. Try again, or type the address from the join poster.'
    )
  })
})
