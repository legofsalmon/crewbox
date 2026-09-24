// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearJoinLink,
  currentJoinLink,
  installAppLinks,
  receiveLink,
  subscribeJoinLink,
} from './appLinks.ts'

/**
 * Links that open the app, as Capacitor's App plugin hands them over: the one
 * that started it, from `getLaunchUrl`, and any tapped while it runs, as
 * `appUrlOpen`. Only a join link is kept, and keeping it is all that happens
 * here: the join form or Your boxes fills it in, and nothing is contacted.
 */

const LINK = 'crewbox://join?server=192.168.8.1&pin=4821'

let opened: ((event: { url: string }) => void) | undefined
let launch: () => Promise<{ url: string } | undefined>

function inApp(withLaunchUrl = true): { getLaunchUrl: ReturnType<typeof vi.fn> } {
  opened = undefined
  const getLaunchUrl = vi.fn(() => launch())
  window.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    Plugins: {
      App: {
        addListener: (event: string, listener: (event: never) => void) => {
          if (event === 'appUrlOpen') opened = listener as (event: { url: string }) => void
          return { remove: () => {} }
        },
        minimizeApp: async () => {},
        ...(withLaunchUrl ? { getLaunchUrl } : {}),
      },
    },
  }
  return { getLaunchUrl }
}

/** How this page came to be, as the browser's navigation timing says. */
function navigation(type: 'navigate' | 'reload'): void {
  vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
    { type } as unknown as PerformanceEntry,
  ])
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  clearJoinLink()
  launch = async () => undefined
  navigation('navigate')
})

afterEach(() => {
  vi.restoreAllMocks()
  delete window.Capacitor
})

describe('a join link', () => {
  it('that started the app is kept for the join form', async () => {
    inApp()
    launch = async () => ({ url: LINK })
    installAppLinks()
    await settle()
    expect(currentJoinLink()).toEqual({ origin: 'http://192.168.8.1', pin: '4821' })
  })

  it('tapped while the app runs is kept too, each as a new one', async () => {
    inApp()
    installAppLinks()
    await settle()
    expect(currentJoinLink()).toBeNull()

    const told = vi.fn()
    const unsubscribe = subscribeJoinLink(told)
    opened!({ url: LINK })
    const first = currentJoinLink()
    expect(first).toEqual({ origin: 'http://192.168.8.1', pin: '4821' })
    // The same link again is a new tap, and the form fills in again.
    opened!({ url: LINK })
    expect(currentJoinLink()).not.toBe(first)
    expect(told).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('is let go once the form has it', () => {
    receiveLink(LINK)
    const told = vi.fn()
    subscribeJoinLink(told)
    clearJoinLink()
    expect(currentJoinLink()).toBeNull()
    expect(told).toHaveBeenCalledOnce()
    clearJoinLink()
    expect(told).toHaveBeenCalledOnce()
  })
})

describe('anything else', () => {
  it('is let go, keeping a link that is still waiting', () => {
    receiveLink(LINK)
    for (const url of [
      'crewbox://settings',
      'crewbox://join?server=192.168.8.1%2Fadmin',
      'https://192.168.8.1/?pin=4821',
      '',
    ]) {
      receiveLink(url)
      expect(currentJoinLink(), url).toEqual({ origin: 'http://192.168.8.1', pin: '4821' })
    }
  })
})

describe('the link that started the app', () => {
  it('is taken once, told of both ways as the plugins tell it', async () => {
    inApp()
    launch = async () => ({ url: LINK })
    const told = vi.fn()
    const unsubscribe = subscribeJoinLink(told)
    installAppLinks()
    // The App plugin's appUrlOpen for the starting link, held until the page
    // listened, arrives before getLaunchUrl answers with the same link.
    opened!({ url: LINK })
    await settle()
    expect(told).toHaveBeenCalledOnce()
    expect(currentJoinLink()).toEqual({ origin: 'http://192.168.8.1', pin: '4821' })
    unsubscribe()
  })

  it('is not taken again when the page reloads, as opening another event does', async () => {
    const { getLaunchUrl } = inApp()
    launch = async () => ({ url: LINK })
    navigation('reload')
    installAppLinks()
    await settle()
    expect(getLaunchUrl).not.toHaveBeenCalled()
    expect(currentJoinLink()).toBeNull()
    // A link tapped after the reload is still taken.
    opened!({ url: LINK })
    expect(currentJoinLink()).not.toBeNull()
  })

  it('is no link at all when the platform has none, or cannot say', async () => {
    inApp()
    installAppLinks()
    await settle()
    expect(currentJoinLink()).toBeNull()

    inApp()
    launch = () => Promise.reject(new Error('not implemented'))
    installAppLinks()
    await settle()
    expect(currentJoinLink()).toBeNull()
  })
})

describe('outside the apps', () => {
  it('listens for nothing', () => {
    expect(() => installAppLinks()).not.toThrow()
    expect(currentJoinLink()).toBeNull()
  })
})

describe('an App plugin that cannot say how the app started', () => {
  it('still hands over links tapped while it runs', () => {
    inApp(false)
    installAppLinks()
    opened!({ url: LINK })
    expect(currentJoinLink()).toEqual({ origin: 'http://192.168.8.1', pin: '4821' })
  })
})
