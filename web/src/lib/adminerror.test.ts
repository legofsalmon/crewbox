// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { adminError } from './adminerror.ts'
import { ApiError } from './api.ts'
import { useStore } from '../store.ts'

/**
 * The store's own comment said any 403 gave the unlock back. Nothing did:
 * every row in the panel caught the error, printed the server's message, and
 * left the dead token in place — so every button after that failed the same
 * way, with no route back to the password box short of reloading the page.
 */

beforeEach(() => {
  useStore.setState({ adminToken: 'unlocked', adminOpen: true, adminLockedReason: null })
})

describe('reporting a failed admin request', () => {
  it('gives the unlock back when the box stops honouring it', () => {
    const message = adminError(new ApiError('admin unlock required', 403), 'Save failed')
    expect(useStore.getState().adminToken).toBeNull()
    expect(message).toMatch(/restarted/)
    // The reason survives for the unlock screen to explain itself with.
    expect(useStore.getState().adminLockedReason).toBe(message)
  })

  it('leaves the panel open, so the password box comes up in its place', () => {
    // Not `lockAdmin`, which closes the whole thing — that is the Lock
    // button, a deliberate act. Being thrown out mid-task is not.
    adminError(new ApiError('admin unlock required', 403), 'Save failed')
    expect(useStore.getState().adminOpen).toBe(true)
  })

  it('keeps the unlock for every other failure, and says what the box said', () => {
    const message = adminError(new ApiError('that PIN is already in use', 400), 'PIN reset failed')
    expect(message).toBe('that PIN is already in use')
    expect(useStore.getState().adminToken).toBe('unlocked')
  })

  it('falls back to the caller’s own words when there is no reply to quote', () => {
    // A dropped connection is not an ApiError and carries nothing worth
    // showing a person.
    expect(adminError(new TypeError('Failed to fetch'), 'Save failed')).toBe('Save failed')
    expect(useStore.getState().adminToken).toBe('unlocked')
  })
})
