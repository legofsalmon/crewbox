// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { boxWifiSettled, holdBoxWifi, setServerOrigin } from './server.ts'

/**
 * The page telling the Android app which box it uses, so the app keeps its
 * traffic for the box on the box's Wi-Fi when that Wi-Fi has no internet
 * (native SiteWifi), and a join waiting to hear that it has.
 */

type Answer = { onWifi: boolean }

let told: string[]
let answer: () => Promise<Answer>

function inAndroidApp(): void {
  window.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    Plugins: {
      CrewboxNetwork: {
        useBox: async ({ origin }: { origin: string }) => {
          told.push(origin)
          return answer()
        },
      },
    },
  }
}

/** Whether a promise has settled, after everything already queued has run. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false
  void promise.then(() => (done = true))
  await vi.advanceTimersByTimeAsync(0)
  return done
}

beforeEach(() => {
  vi.useFakeTimers()
  told = []
  answer = async () => ({ onWifi: true })
  localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
  delete window.Capacitor
})

describe('telling the Android app its box', () => {
  it('happens whenever the page is given one, in the form the page keeps it', () => {
    inAndroidApp()
    setServerOrigin('192.168.8.1:3000')
    setServerOrigin('https://chat.crew.example/')
    expect(told).toEqual(['http://192.168.8.1:3000', 'https://chat.crew.example'])
  })

  it('says so when the page has no box any more', () => {
    inAndroidApp()
    setServerOrigin('192.168.8.1')
    setServerOrigin('')
    expect(told).toEqual(['http://192.168.8.1', ''])
  })

  it('tells it the box the page kept, at startup', () => {
    inAndroidApp()
    localStorage.setItem('crewbox:server-url', 'http://10.0.0.5:3000')
    holdBoxWifi()
    expect(told).toEqual(['http://10.0.0.5:3000'])
  })

  it('does nothing in a browser or the iPhone app', async () => {
    setServerOrigin('192.168.8.1')
    holdBoxWifi()
    expect(await settled(boxWifiSettled())).toBe(true)
  })
})

describe('a join', () => {
  it('waits for the app to say where the box’s traffic goes', async () => {
    inAndroidApp()
    let say: (answer: Answer) => void = () => {}
    answer = () => new Promise((resolve) => (say = resolve))
    setServerOrigin('192.168.8.1')
    const wait = boxWifiSettled()
    expect(await settled(wait)).toBe(false)
    say({ onWifi: true })
    expect(await settled(wait)).toBe(true)
  })

  it('waits for the latest box it was told of', async () => {
    inAndroidApp()
    const says: Array<(answer: Answer) => void> = []
    answer = () => new Promise((resolve) => says.push(resolve))
    setServerOrigin('192.168.8.1')
    setServerOrigin('10.0.0.5')
    says[0]!({ onWifi: true })
    expect(await settled(boxWifiSettled())).toBe(false)
    says[1]!({ onWifi: false })
    expect(await settled(boxWifiSettled())).toBe(true)
  })

  it('goes ahead after a few seconds if the app never answers', async () => {
    inAndroidApp()
    answer = () => new Promise(() => {})
    setServerOrigin('192.168.8.1')
    const wait = boxWifiSettled()
    await vi.advanceTimersByTimeAsync(2900)
    expect(await settled(wait)).toBe(false)
    await vi.advanceTimersByTimeAsync(100)
    expect(await settled(wait)).toBe(true)
  })

  it('goes ahead if the app fails to answer', async () => {
    inAndroidApp()
    answer = async () => {
      throw new Error('not implemented')
    }
    setServerOrigin('192.168.8.1')
    expect(await settled(boxWifiSettled())).toBe(true)
  })
})
