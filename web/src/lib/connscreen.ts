import type { Connection, Elsewhere } from '../store.ts'

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
export function connectionCauses(input: {
  ssid?: string
  isIos: boolean
  /** The app, which can be told another address from its Boxes screen. */
  canMoveBox?: boolean
  /**
   * The app is looking for the box on the Wi-Fi as this is read, to follow it
   * to wherever it proves itself (lib/follow.ts).
   */
  looksForBox?: boolean
}): ConnCause[] {
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
  if (input.canMoveBox) {
    // Last: rarer than any of the above, and the only one that may not clear
    // by itself. The app keeps trying the address it has, and where it can
    // look for the box on the Wi-Fi, it is looking.
    causes.push({
      heading: 'The box may have a new address',
      body: input.looksForBox
        ? 'This phone is looking for it on this Wi-Fi, and goes on there by itself once the ' +
          'box shows it is the same one. If it isn’t found, tap Your boxes and type the ' +
          'address on its join poster.'
        : 'If it has been moved or set up somewhere else, tap Your boxes to look for it on ' +
          'this Wi-Fi, or type the address on its join poster.',
    })
  }

  return causes
}

/**
 * What to say when the box at this address is running another event than
 * the one this device has open — a spare with a fresh database, or the next
 * event's box — and so has been given nothing of this one's.
 *
 * Its name is all there is to go on. A spare set up under the event's own
 * name is the same name starting over, and one not set up has none.
 */
export function elsewhereCopy(input: { address: string; open: string; here: string }): string {
  const here = input.here.trim()
  if (!here) return `The box at ${input.address} has changed, and is starting afresh.`
  if (here === input.open.trim()) {
    return `The box at ${input.address} has changed, and is starting “${here}” afresh.`
  }
  return `The box at ${input.address} is running “${here}” now.`
}

const eventNamed = (name: string): string => (name.trim() ? `“${name.trim()}”` : 'an event')

/**
 * What to say when a box says it runs an event this phone holds at another
 * address, answers the check, and fails it (lib/identity.ts): anything that
 * took an address can say which event it runs.
 */
export function refusedCopy(input: { address: string; name: string }): string {
  return (
    `The box at ${input.address} says it is running ${eventNamed(input.name)}, but it can’t ` +
    'show that it is that event’s box, so nothing has gone to it.'
  )
}

/**
 * What to say while the box at this address, running an event this phone
 * holds at another address, has not shown it is that event's box: being
 * checked, failing, or unable to be checked. Nothing goes to it meanwhile.
 */
export function unprovenCopy(input: {
  address: string
  name: string
  heldAt: string
  proof: 'checking' | 'refused' | 'unchecked'
}): string {
  const says = `The box at ${input.address} says it is running ${eventNamed(input.name)}`
  switch (input.proof) {
    case 'checking':
      return `${says}, which this phone knows at ${input.heldAt}. Checking that it is…`
    case 'refused':
      return refusedCopy(input)
    case 'unchecked':
      return (
        `${says}, which this phone knows at ${input.heldAt}. It can’t be checked, so nothing ` +
        'has gone to it. If that box has moved here, type this address in Your boxes.'
      )
  }
}

/**
 * What the screens say about the event at this address, and whether they
 * offer to open it: not while it is an event this phone holds elsewhere
 * whose box has not shown it is that event's.
 */
export function elsewhereView(input: { address: string; open: string; here: Elsewhere }): {
  copy: string
  opens: boolean
} {
  const { held, name } = input.here
  if (!held) {
    return {
      copy: elsewhereCopy({ address: input.address, open: input.open, here: name }),
      opens: true,
    }
  }
  const heldAt = held.origin.replace(/^https?:\/\//i, '')
  if (held.proof === 'proven') {
    // Not a new event, and not starting afresh: the one this phone had
    // somewhere else, whose box is here now.
    return {
      copy: name.trim()
        ? `The box at ${input.address} is running “${name.trim()}”, which this phone knew at ${heldAt}.`
        : `The box at ${input.address} is running the event this phone knew at ${heldAt}.`,
      opens: true,
    }
  }
  return {
    copy: unprovenCopy({ address: input.address, name, heldAt, proof: held.proof }),
    opens: false,
  }
}
