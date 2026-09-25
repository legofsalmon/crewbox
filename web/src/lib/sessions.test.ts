// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionsPlugin } from './server.ts'

/**
 * Where a device keeps its sign-ins (sessions.ts).
 *
 * In a browser, the page's storage as always. In the apps, the app's
 * Keychain or Keystore, stood in for here by a map, with the page's storage
 * naming each sign-in the app keeps. Each test loads the module afresh, as a
 * page load does, since what the page has heard from the app is its own.
 */

type Sessions = typeof import('./sessions.ts')

async function load(): Promise<Sessions> {
  vi.resetModules()
  return import('./sessions.ts')
}

/** The app's side: a Keychain that answers, or refuses, as a test says. */
function app(kept: Record<string, string> = {}) {
  const keychain = new Map(Object.entries(kept))
  const plugin = {
    keychain,
    refuseSaves: false,
    load: vi.fn<SessionsPlugin['load']>(async () => ({ sessions: Object.fromEntries(keychain) })),
    save: vi.fn<SessionsPlugin['save']>(async ({ name, token }) => {
      if (plugin.refuseSaves) throw new Error('The keystore refused')
      keychain.set(name, token)
    }),
    forget: vi.fn<SessionsPlugin['forget']>(async ({ name }) => {
      keychain.delete(name)
    }),
  }
  ;(window as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'ios',
    Plugins: { CrewboxSessions: plugin },
  }
  return plugin
}

beforeEach(() => localStorage.clear())
afterEach(() => {
  delete (window as { Capacitor?: unknown }).Capacitor
  vi.useRealTimers()
})

describe('in a browser', () => {
  it('keeps a sign-in in the page’s storage, as it always has', async () => {
    const sessions = await load()
    await sessions.loadSessions()
    await sessions.saveSession('crewbox:token', 'fridays-sign-in')
    expect(localStorage.getItem('crewbox:token')).toBe('fridays-sign-in')
    expect(sessions.readSession('crewbox:token')).toBe('fridays-sign-in')
    expect(sessions.openSession()).toBe('fridays-sign-in')
    await sessions.forgetSession('crewbox:token')
    expect(localStorage.getItem('crewbox:token')).toBeNull()
    expect(sessions.readSession('crewbox:token')).toBeNull()
  })

  it('reads a token the page kept before this, untouched', async () => {
    localStorage.setItem('crewbox:token', 'fridays-sign-in')
    const sessions = await load()
    await sessions.loadSessions()
    expect(localStorage.getItem('crewbox:token')).toBe('fridays-sign-in')
    expect(sessions.openSession()).toBe('fridays-sign-in')
  })
})

describe('in the apps', () => {
  it('keeps the token in the app, and only its name in the page’s storage', async () => {
    const plugin = app()
    const sessions = await load()
    await sessions.loadSessions()
    await sessions.saveSession('crewbox:token', 'fridays-sign-in')
    expect(plugin.keychain.get('crewbox:token')).toBe('fridays-sign-in')
    expect(localStorage.getItem('crewbox:token')).toBe(sessions.HELD)
    expect(sessions.readSession('crewbox:token')).toBe('fridays-sign-in')
    expect(sessions.openSession()).toBe('fridays-sign-in')
  })

  it('reads the app’s sign-ins at the next start', async () => {
    const plugin = app({ 'crewbox:token': 'fridays-sign-in' })
    const sessions = await load()
    localStorage.setItem('crewbox:token', sessions.HELD)
    await sessions.loadSessions()
    expect(sessions.openSession()).toBe('fridays-sign-in')
    expect(plugin.forget).not.toHaveBeenCalled()
    expect(plugin.save).not.toHaveBeenCalled()
  })

  it('has nothing to read before the app has answered', async () => {
    // Why main.tsx renders only once they are loaded.
    app({ 'crewbox:token': 'fridays-sign-in' })
    const sessions = await load()
    localStorage.setItem('crewbox:token', sessions.HELD)
    expect(sessions.openSession()).toBeNull()
    await sessions.loadSessions()
    expect(sessions.openSession()).toBe('fridays-sign-in')
  })

  it('moves a token the page kept before this into the app, every event’s', async () => {
    const plugin = app()
    localStorage.setItem('crewbox:token', 'fridays-sign-in')
    localStorage.setItem('crewbox@saturday:token', 'saturdays-sign-in')
    localStorage.setItem('crewbox:theme', 'dark')
    localStorage.setItem('crewbox:event-name', 'Harbour Fest')
    const sessions = await load()
    await sessions.loadSessions()
    expect(Object.fromEntries(plugin.keychain)).toEqual({
      'crewbox:token': 'fridays-sign-in',
      'crewbox@saturday:token': 'saturdays-sign-in',
    })
    expect(localStorage.getItem('crewbox:token')).toBe(sessions.HELD)
    expect(localStorage.getItem('crewbox@saturday:token')).toBe(sessions.HELD)
    expect(sessions.readSession('crewbox@saturday:token')).toBe('saturdays-sign-in')
    // Nothing that isn't a sign-in.
    expect(localStorage.getItem('crewbox:theme')).toBe('dark')
    expect(localStorage.getItem('crewbox:event-name')).toBe('Harbour Fest')
  })

  it('leaves a sign-in in the page’s storage when the app can’t keep it', async () => {
    const plugin = app()
    plugin.refuseSaves = true
    localStorage.setItem('crewbox:token', 'fridays-sign-in')
    const sessions = await load()
    await sessions.loadSessions()
    expect(localStorage.getItem('crewbox:token')).toBe('fridays-sign-in')
    expect(sessions.openSession()).toBe('fridays-sign-in')
    // And a new one, rather than signing the crew member out.
    await sessions.saveSession('crewbox@saturday:token', 'saturdays-sign-in')
    expect(localStorage.getItem('crewbox@saturday:token')).toBe('saturdays-sign-in')
    expect(sessions.readSession('crewbox@saturday:token')).toBe('saturdays-sign-in')
    expect(plugin.keychain.size).toBe(0)
  })

  it('drops a sign-in the page’s storage no longer names: the app installed again', async () => {
    // An iPhone's Keychain outlives the app. Kept, this would have signed a
    // fresh install in with nowhere to go.
    const plugin = app({ 'crewbox:token': 'fridays-sign-in', 'crewbox@sat:token': 'saturdays' })
    const sessions = await load()
    await sessions.loadSessions()
    expect(plugin.forget).toHaveBeenCalledTimes(2)
    expect(plugin.keychain.size).toBe(0)
    expect(sessions.openSession()).toBeNull()
    expect(sessions.readSession('crewbox@sat:token')).toBeNull()
  })

  it('is signed out of an event whose name came in a backup without its token', async () => {
    const plugin = app()
    const sessions = await load()
    localStorage.setItem('crewbox:token', sessions.HELD)
    localStorage.setItem('crewbox@saturday:token', sessions.HELD)
    await sessions.loadSessions()
    expect(localStorage.getItem('crewbox:token')).toBeNull()
    expect(localStorage.getItem('crewbox@saturday:token')).toBeNull()
    expect(sessions.openSession()).toBeNull()
    expect(plugin.keychain.size).toBe(0)
  })

  it('takes a token in the page’s storage over an older one in the app', async () => {
    // The page wrote it last: a newer sign-in the app couldn't keep, which
    // stayed in the page's storage (saveSession) over the app's older one.
    const plugin = app({ 'crewbox:token': 'older-sign-in' })
    localStorage.setItem('crewbox:token', 'newer-sign-in')
    const sessions = await load()
    await sessions.loadSessions()
    expect(plugin.keychain.get('crewbox:token')).toBe('newer-sign-in')
    expect(localStorage.getItem('crewbox:token')).toBe(sessions.HELD)
    expect(sessions.openSession()).toBe('newer-sign-in')
  })

  it('deletes nothing when the app doesn’t answer, and starts signed out', async () => {
    const plugin = app({ 'crewbox:token': 'fridays-sign-in' })
    plugin.load.mockRejectedValue(new Error('errSecInteractionNotAllowed'))
    const sessions = await load()
    localStorage.setItem('crewbox:token', sessions.HELD)
    localStorage.setItem('crewbox@saturday:token', 'saturdays-sign-in')
    await sessions.loadSessions()
    expect(sessions.openSession()).toBeNull()
    expect(localStorage.getItem('crewbox:token')).toBe(sessions.HELD)
    expect(plugin.keychain.get('crewbox:token')).toBe('fridays-sign-in')
    expect(plugin.forget).not.toHaveBeenCalled()
    // Nor moves anything, until it has said what it keeps.
    expect(plugin.save).not.toHaveBeenCalled()
    expect(localStorage.getItem('crewbox@saturday:token')).toBe('saturdays-sign-in')
  })

  it('starts without the app’s sign-ins when it never answers, rather than not at all', async () => {
    vi.useFakeTimers()
    const plugin = app({ 'crewbox:token': 'fridays-sign-in' })
    plugin.load.mockReturnValue(new Promise(() => {}))
    const sessions = await load()
    localStorage.setItem('crewbox:token', sessions.HELD)
    let settled = false
    void sessions.loadSessions().then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(4900)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    expect(settled).toBe(true)
    expect(localStorage.getItem('crewbox:token')).toBe(sessions.HELD)
    expect(plugin.forget).not.toHaveBeenCalled()
  })

  it('forgets a sign-in in the app and the page alike', async () => {
    const plugin = app()
    const sessions = await load()
    await sessions.loadSessions()
    await sessions.saveSession('crewbox:token', 'fridays-sign-in')
    await sessions.forgetSession('crewbox:token')
    expect(plugin.keychain.size).toBe(0)
    expect(localStorage.getItem('crewbox:token')).toBeNull()
    expect(sessions.openSession()).toBeNull()
  })

  it('forgets the page’s copy even when the app can’t be asked', async () => {
    const plugin = app()
    plugin.forget.mockRejectedValue(new Error('gone'))
    const sessions = await load()
    await sessions.loadSessions()
    await sessions.saveSession('crewbox:token', 'fridays-sign-in')
    await sessions.forgetSession('crewbox:token')
    expect(localStorage.getItem('crewbox:token')).toBeNull()
    expect(sessions.openSession()).toBeNull()
  })

  it('reads the open event’s sign-in by its storage name', async () => {
    app({ 'crewbox@saturday:token': 'saturdays-sign-in', 'crewbox:token': 'fridays-sign-in' })
    localStorage.setItem('crewbox:db-epoch', 'friday')
    localStorage.setItem('crewbox:event', 'saturday')
    const sessions = await load()
    localStorage.setItem('crewbox:token', sessions.HELD)
    localStorage.setItem('crewbox@saturday:token', sessions.HELD)
    await sessions.loadSessions()
    expect(sessions.openSession()).toBe('saturdays-sign-in')
    expect(sessions.readSession('crewbox:token')).toBe('fridays-sign-in')
  })

  it('knows a sign-in’s name from any other storage name', async () => {
    const { isSessionName } = await load()
    expect(isSessionName('crewbox:token')).toBe(true)
    expect(isSessionName('crewbox@saturday:token')).toBe(true)
    expect(isSessionName('crewbox:token-x')).toBe(false)
    expect(isSessionName('crewbox@sat-urday:token')).toBe(false)
    expect(isSessionName('crewbox:theme')).toBe(false)
    expect(isSessionName('crewbox@saturday:modules')).toBe(false)
  })

  it('is a placeholder no token can be', async () => {
    const { HELD } = await load()
    // A box mints tokens as base64url (server/src/auth.ts newToken).
    expect(HELD).not.toMatch(/^[A-Za-z0-9_-]*$/)
  })
})

describe('a sign-in moved out of the page’s storage', () => {
  /**
   * What the box answers: a new token, as it mints them (base64url, 43
   * characters), standing in for the old one until it is first used.
   */
  const NEW = 'n'.repeat(43)

  /** A page load in the app with the old page's token still in its storage. */
  async function moved(names = ['crewbox:token']) {
    const plugin = app()
    for (const name of names) localStorage.setItem(name, `old-${name}`)
    const sessions = await load()
    await sessions.loadSessions()
    return { plugin, sessions }
  }

  const carried = () => JSON.parse(localStorage.getItem('crewbox:carried-sign-ins') ?? '[]')

  it('is marked for its box to renew, every event’s, by name only', async () => {
    const { sessions } = await moved(['crewbox:token', 'crewbox@saturday:token'])
    expect(carried()).toEqual(['crewbox:token', 'crewbox@saturday:token'])
    expect(localStorage.getItem('crewbox:carried-sign-ins')).not.toContain('old-')
    expect(sessions.openSession()).toBe('old-crewbox:token')
  })

  it('is marked once, however often it moves', async () => {
    // A later sign-in the app couldn't keep, left in the page's storage, and
    // moved at a start after.
    await moved()
    localStorage.setItem('crewbox:token', 'later-sign-in')
    const again = await load()
    await again.loadSessions()
    expect(carried()).toEqual(['crewbox:token'])
    expect(again.openSession()).toBe('later-sign-in')
  })

  it('is swapped for the box’s new one before anything else uses it, once', async () => {
    const { plugin, sessions } = await moved()
    const renew = vi.fn(async () => NEW)
    await sessions.renewCarried('crewbox:token', renew)
    expect(renew).toHaveBeenCalledWith('old-crewbox:token')
    expect(plugin.keychain.get('crewbox:token')).toBe(NEW)
    expect(localStorage.getItem('crewbox:token')).toBe(sessions.HELD)
    expect(sessions.openSession()).toBe(NEW)
    expect(carried()).toEqual([])
    expect(localStorage.getItem('crewbox:carried-sign-ins')).toBeNull()
    await sessions.renewCarried('crewbox:token', renew)
    expect(renew).toHaveBeenCalledTimes(1)
    // Nor at the next start, where the app keeps it and the page names it.
    const again = await load()
    await again.loadSessions()
    await again.renewCarried('crewbox:token', renew)
    expect(renew).toHaveBeenCalledTimes(1)
    expect(again.openSession()).toBe(NEW)
  })

  it('renews only the event asked about', async () => {
    const { sessions } = await moved(['crewbox:token', 'crewbox@saturday:token'])
    await sessions.renewCarried('crewbox@saturday:token', async () => NEW)
    expect(carried()).toEqual(['crewbox:token'])
    expect(sessions.readSession('crewbox:token')).toBe('old-crewbox:token')
    expect(sessions.readSession('crewbox@saturday:token')).toBe(NEW)
  })

  it('keeps the old one, and asks again at the next start, when the box doesn’t say', async () => {
    const { plugin, sessions } = await moved()
    await sessions.renewCarried('crewbox:token', async () => {
      throw new TypeError('Failed to fetch')
    })
    expect(sessions.openSession()).toBe('old-crewbox:token')
    expect(carried()).toEqual(['crewbox:token'])
    const again = await load()
    await again.loadSessions()
    const renew = vi.fn(async () => NEW)
    await again.renewCarried('crewbox:token', renew)
    expect(renew).toHaveBeenCalledWith('old-crewbox:token')
    expect(plugin.keychain.get('crewbox:token')).toBe(NEW)
    expect(carried()).toEqual([])
  })

  it('takes nothing but a token for an answer', async () => {
    const { sessions } = await moved()
    for (const answer of ['', 'short', 'x'.repeat(257), 'has spaces in it at all', HELD_LIKE, 42]) {
      await sessions.renewCarried('crewbox:token', async () => answer as string)
      expect(sessions.openSession()).toBe('old-crewbox:token')
      expect(carried()).toEqual(['crewbox:token'])
    }
  })

  it('is forgotten with the sign-in', async () => {
    const { sessions } = await moved(['crewbox:token', 'crewbox@saturday:token'])
    await sessions.forgetSession('crewbox:token')
    expect(carried()).toEqual(['crewbox@saturday:token'])
    await sessions.forgetSession('crewbox@saturday:token')
    expect(localStorage.getItem('crewbox:carried-sign-ins')).toBeNull()
  })

  it('is forgotten when a backup brings the mark and the name but not the token', async () => {
    const plugin = app()
    const sessions = await load()
    localStorage.setItem('crewbox:token', sessions.HELD)
    localStorage.setItem('crewbox:carried-sign-ins', JSON.stringify(['crewbox:token']))
    await sessions.loadSessions()
    expect(localStorage.getItem('crewbox:carried-sign-ins')).toBeNull()
    const renew = vi.fn(async () => NEW)
    await sessions.renewCarried('crewbox:token', renew)
    expect(renew).not.toHaveBeenCalled()
    expect(plugin.keychain.size).toBe(0)
  })

  it('isn’t marked where the app can’t keep it, until it can', async () => {
    // Left in the page's storage, a new one would be there too.
    const plugin = app()
    plugin.refuseSaves = true
    localStorage.setItem('crewbox:token', 'old-crewbox:token')
    const sessions = await load()
    await sessions.loadSessions()
    expect(carried()).toEqual([])
    const renew = vi.fn(async () => NEW)
    await sessions.renewCarried('crewbox:token', renew)
    expect(renew).not.toHaveBeenCalled()
    plugin.refuseSaves = false
    const again = await load()
    await again.loadSessions()
    expect(carried()).toEqual(['crewbox:token'])
    await again.renewCarried('crewbox:token', renew)
    expect(renew).toHaveBeenCalledWith('old-crewbox:token')
    expect(again.openSession()).toBe(NEW)
  })

  it('goes to the page’s storage when the app can’t keep the new one, and is moved again later', async () => {
    const { plugin, sessions } = await moved()
    plugin.refuseSaves = true
    await sessions.renewCarried('crewbox:token', async () => NEW)
    expect(localStorage.getItem('crewbox:token')).toBe(NEW)
    expect(sessions.openSession()).toBe(NEW)
    plugin.refuseSaves = false
    const again = await load()
    await again.loadSessions()
    expect(plugin.keychain.get('crewbox:token')).toBe(NEW)
    expect(carried()).toEqual(['crewbox:token'])
  })

  it('reads a mark that isn’t a list of sign-in names as none', async () => {
    const { sessions } = await moved()
    const renew = vi.fn(async () => NEW)
    for (const mark of ['not json', '{"crewbox:token":true}', '["crewbox:theme", 7]']) {
      localStorage.setItem('crewbox:carried-sign-ins', mark)
      await sessions.renewCarried('crewbox:token', renew)
    }
    expect(renew).not.toHaveBeenCalled()
    expect(sessions.openSession()).toBe('old-crewbox:token')
  })

  it('keeps nothing in the mark but sign-in names', async () => {
    const { sessions } = await moved()
    localStorage.setItem(
      'crewbox:carried-sign-ins',
      JSON.stringify(['crewbox:token', 7, 'crewbox:theme', 'crewbox:token'])
    )
    await sessions.renewCarried('crewbox:token', async () => NEW)
    expect(localStorage.getItem('crewbox:carried-sign-ins')).toBeNull()
  })

  it('is never marked in a browser, where the page’s storage is where it lives', async () => {
    localStorage.setItem('crewbox:token', 'fridays-sign-in')
    const sessions = await load()
    await sessions.loadSessions()
    const renew = vi.fn(async () => NEW)
    await sessions.renewCarried('crewbox:token', renew)
    expect(renew).not.toHaveBeenCalled()
    expect(localStorage.getItem('crewbox:carried-sign-ins')).toBeNull()
  })

  it('is its own name, which reaches phones', async () => {
    // Renamed, the marks on phones already updated would be lost, and their
    // sign-ins never renewed.
    await moved()
    expect(Object.keys(localStorage)).toContain('crewbox:carried-sign-ins')
  })
})

/** The placeholder's own text, which a box never answers with. */
const HELD_LIKE = '(kept by the app)'
