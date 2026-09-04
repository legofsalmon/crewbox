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
  /**
   * Whether a connection attempt has already failed this session.
   *
   * Sticky, and it has to be. A cold start with no cache retries on a
   * backoff, and the state cycles offline → connecting → offline; without
   * this the screen flapped between "Can't reach the crew server" and
   * "Connecting…" every few seconds, which reads as a device that cannot
   * make up its mind rather than a box that is not there. Once the first
   * attempt has failed, the recovery screen stays up and says it is
   * retrying — the message that is actually true.
   */
  hasFailed?: boolean
}): ConnScreen {
  if (input.hasConnected || input.hasCache) return 'ok'
  if (input.connection === 'offline' || input.hasFailed) return 'unreachable'
  return 'connecting'
}

/**
 * How long a returning user watches the thin banner before the app offers to
 * explain itself.
 *
 * Long enough that an access-point roam, a box restart or a lift never
 * triggers it — those resolve in a few seconds and an explanation would be
 * noise. Short enough that nobody stands at a production desk wondering
 * whether the thing is broken.
 */
export const STUCK_AFTER_MS = 25_000

export interface ConnCause {
  heading: string
  body: string
}

/**
 * What to tell someone whose app is up but whose box has been unreachable
 * for a while.
 *
 * Ordered by how often each one is actually the answer, not by how
 * interesting it is. The iOS entry leads on that platform because it is the
 * only cause that is completely invisible from inside the app — the phone
 * reports a healthy Wi-Fi connection while routing everything past it — and
 * because it cost a real event an hour before anyone thought to look at the
 * status bar. It is omitted elsewhere: Android does not do this, and a cause
 * that cannot apply is a cause that wastes the reader's time.
 *
 * Pure so the copy is guarded by tests: this text is read by someone under
 * pressure, and a reordering that buries the invisible cause would quietly
 * undo the point of the screen.
 */
export function connectionCauses(input: { ssid?: string; isIos: boolean }): ConnCause[] {
  const network = input.ssid ? `“${input.ssid}”` : 'the crew Wi-Fi'
  const causes: ConnCause[] = []

  if (input.isIos) {
    causes.push({
      heading: 'Check the Wi-Fi symbol in your status bar',
      body:
        `If it has gone, your iPhone decided ${network} has no internet and moved to mobile ` +
        'data — which cannot reach the crew box, even though the Wi-Fi still shows as joined. ' +
        'Turn mobile data off for a minute and it comes straight back. Tell whoever runs the ' +
        'box: there is a proper fix for this at their end.',
    })
  }

  causes.push({
    heading: `Make sure you are on ${network}`,
    body: 'Phones drift onto other networks between buildings, and some rejoin the last one they saw rather than this one.',
  })
  causes.push({
    heading: 'You may have walked out of range',
    body: 'Move back towards an access point. The app reconnects on its own the moment it can.',
  })
  causes.push({
    heading: 'The box may be restarting',
    body: 'An update or a restart takes under a minute, and this clears by itself when it comes back.',
  })

  return causes
}
