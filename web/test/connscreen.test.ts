import { describe, expect, it } from 'vitest'
import { connectionScreen } from '../src/lib/connscreen.ts'

describe('connectionScreen', () => {
  it('shows chat (ok) once connected this session, regardless of connection state', () => {
    for (const connection of ['connecting', 'online', 'offline'] as const) {
      expect(connectionScreen({ connection, hasConnected: true, hasCache: false })).toBe('ok')
    }
  })

  it('shows chat (ok) for returning users with cached content, even while offline', () => {
    expect(connectionScreen({ connection: 'offline', hasConnected: false, hasCache: true })).toBe(
      'ok',
    )
  })

  it('shows the recovery screen only when offline with nothing cached', () => {
    expect(
      connectionScreen({ connection: 'offline', hasConnected: false, hasCache: false }),
    ).toBe('unreachable')
  })

  it('shows a calm connecting state during the first connect with no cache', () => {
    expect(
      connectionScreen({ connection: 'connecting', hasConnected: false, hasCache: false }),
    ).toBe('connecting')
    // 'online' but pre-welcome (no cache yet) is still "connecting", not an error.
    expect(connectionScreen({ connection: 'online', hasConnected: false, hasCache: false })).toBe(
      'connecting',
    )
  })
})
