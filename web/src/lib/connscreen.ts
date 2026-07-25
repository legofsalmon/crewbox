import type { Connection } from '../store.ts'

/** Which full-screen state the chat phase should show before content is ready. */
export type ConnScreen = 'ok' | 'connecting' | 'unreachable'

/**
 * Decide the boot experience for the chat phase:
 * - `ok`: we've connected this session, or we have cached content to show —
 *   render chat as normal (a transient drop is covered by the offline banner).
 * - `unreachable`: the connection has failed and there's nothing cached — show
 *   the branded recovery screen.
 * - `connecting`: still establishing the first connection with nothing cached —
 *   a calm "connecting" state, so a normal first connect never flashes an error.
 *
 * Gating on `hasCache`/`hasConnected` is what protects returning users from ever
 * seeing the error screen: they keep their cached chat and the offline banner.
 */
export function connectionScreen(input: {
  connection: Connection
  hasConnected: boolean
  hasCache: boolean
}): ConnScreen {
  if (input.hasConnected || input.hasCache) return 'ok'
  if (input.connection === 'offline') return 'unreachable'
  return 'connecting'
}
