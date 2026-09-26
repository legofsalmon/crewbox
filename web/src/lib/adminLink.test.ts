// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './api.ts'
import { redeemAdminLink, takeAdminKey, takeAdminLinkOutcome } from './adminLink.ts'
import { useStore } from '../store.ts'

/**
 * The page's half of "Open the admin panel" (server/src/adminLink.ts).
 *
 * The box's menu opens `/?admin#admin-key=…`. The key has to leave the
 * address bar before anything else sees it, and be spent at once, so what a
 * browser's history keeps is a key that no longer works.
 */

/** A stand-in for the address bar, recording what it was changed to. */
function addressBar(url: string) {
  const parsed = new URL(url)
  const bar = {
    pathname: parsed.pathname,
    search: parsed.search,
    hash: parsed.hash,
    state: { from: 'router' } as unknown,
    replaced: [] as string[],
    replaceState(state: unknown, _unused: string, to: string) {
      bar.state = state
      bar.replaced.push(to)
    },
  }
  return bar
}

afterEach(() => {
  takeAdminLinkOutcome()
})

describe('taking the key out of the address', () => {
  it('returns it and leaves the address without it', () => {
    const bar = addressBar('http://localhost:8787/?admin#admin-key=k3y')
    expect(takeAdminKey(bar, bar)).toBe('k3y')
    // `?admin` stays: it is what opens the panel, once the app is up.
    expect(bar.replaced).toEqual(['/?admin'])
  })

  it('keeps anything else in the fragment, and the router state', () => {
    const bar = addressBar('http://localhost:8787/c/general?admin#x=1&admin-key=k3y&y=2')
    expect(takeAdminKey(bar, bar)).toBe('k3y')
    expect(bar.replaced).toEqual(['/c/general?admin#x=1&y=2'])
    expect(bar.state).toEqual({ from: 'router' })
  })

  it('leaves an ordinary address alone', () => {
    for (const url of [
      'http://localhost:8787/',
      'http://localhost:8787/?admin',
      'http://localhost:8787/#something',
      'http://localhost:8787/#admin-key=',
    ]) {
      const bar = addressBar(url)
      expect(takeAdminKey(bar, bar)).toBeNull()
      expect(bar.replaced).toEqual([])
    }
  })

  it('reads the real address bar by default', () => {
    window.history.replaceState(null, '', '/?admin#admin-key=from-the-bar')
    expect(takeAdminKey()).toBe('from-the-bar')
    expect(window.location.hash).toBe('')
    expect(window.location.search).toBe('?admin')
  })
})

describe('spending it', () => {
  it('spends the key at once and holds the unlock for the panel', async () => {
    const unlock = vi.fn(async (key: string) => ({ adminToken: `token-for-${key}` }))
    redeemAdminLink('k3y', unlock)
    // Before anybody opens anything: a key waiting for the join form is a
    // key sitting in the browser's history.
    expect(unlock).toHaveBeenCalledWith('k3y')
    await expect(takeAdminLinkOutcome()).resolves.toEqual({ adminToken: 'token-for-k3y' })
    // Handed over once.
    expect(takeAdminLinkOutcome()).toBeNull()
  })

  it('says why, in the box’s words, when the box refuses it', async () => {
    redeemAdminLink('used', async () => {
      throw new ApiError('That admin link has already been used.', 401)
    })
    await expect(takeAdminLinkOutcome()).resolves.toEqual({
      problem: 'That admin link has already been used.',
    })
  })

  it('says so when the box cannot be reached', async () => {
    redeemAdminLink('k3y', async () => {
      throw new TypeError('Failed to fetch')
    })
    const outcome = await takeAdminLinkOutcome()
    expect(outcome).toMatchObject({ problem: expect.stringMatching(/Could not reach the box/) })
  })

  it('does nothing for a page that came without a link', () => {
    const unlock = vi.fn()
    redeemAdminLink(null, unlock)
    expect(unlock).not.toHaveBeenCalled()
    expect(takeAdminLinkOutcome()).toBeNull()
  })
})

describe('what the panel does with the answer', () => {
  it('opens unlocked', () => {
    useStore.setState({ adminToken: null, adminOpen: true, adminLockedReason: null })
    useStore.getState().adminLinkAnswered({ adminToken: 'from-the-link' })
    expect(useStore.getState().adminToken).toBe('from-the-link')
    expect(useStore.getState().adminLockedReason).toBeNull()
  })

  it('shows the password box saying why the link did not work', () => {
    useStore.setState({ adminToken: null, adminOpen: true, adminLockedReason: null })
    useStore.getState().adminLinkAnswered({ problem: 'That admin link has already been used.' })
    expect(useStore.getState().adminToken).toBeNull()
    expect(useStore.getState().adminLockedReason).toBe('That admin link has already been used.')
  })

  it('says nothing about a spent link to a panel that is already unlocked', () => {
    useStore.setState({
      adminToken: 'typed-the-password',
      adminOpen: true,
      adminLockedReason: null,
    })
    useStore.getState().adminLinkAnswered({ problem: 'That admin link has already been used.' })
    expect(useStore.getState().adminToken).toBe('typed-the-password')
    expect(useStore.getState().adminLockedReason).toBeNull()
  })
})
