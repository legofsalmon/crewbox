import { PROTOCOL_VERSION } from '@crewbox/shared'
import { getConfigAt } from './api.ts'
import { eventIdFrom } from './eventScope.ts'
import { APP_VERSION, knownBuild } from './pwa.ts'
import { isNative, nativeScreens, type ScreensAnswer } from './server.ts'

/**
 * The page's side of the screens the apps run (native ScreensPlugin).
 *
 * In the apps these screens may have come from a box rather than with the
 * app. Screens from a box that don't say they started soon after they load
 * have failed on this phone, crashed or stuck before they could draw, and the
 * app goes back to the screens it came with. So once the first screen has
 * drawn, whatever it is, they say so, without waiting for the network: offline
 * is the ordinary case. The app's own screens say so too, which it takes as
 * nothing to do.
 *
 * A browser gets a new build from its box through the service worker. The
 * apps get one from the box too, but only once the app has fetched its
 * screens and checked that a crewbox release made them, so when a box runs
 * another build the page asks the app for the box's screens before offering
 * them (phase3-design.md, Decision 7). Opening another event asks the same of
 * that event's box, so the reload opens it on its own box's screens.
 */

/** Whether this load has said so. The app counts a start per load, and so does this. */
let told = false

/** Tell the app these screens have started. Once per load; nothing to do in a browser. */
export function screensStarted(): void {
  if (told) return
  told = true
  if (!isNative()) return
  // A refusal changes nothing here: the app goes back only on silence.
  nativeScreens()
    ?.ready({ version: APP_VERSION })
    .catch(() => {})
}

/** What a welcome says of the build its box runs. */
export interface BoxBuild {
  serverVersion?: string
  protocolVersion?: number
}

/**
 * What the page offers of its box's screens, in the apps: a switch to them,
 * which the update pill makes, or a note of what to update when the app can't
 * run them. Null for nothing to say.
 */
export type ScreensOffer =
  { kind: 'switch'; version: string } | { kind: 'note'; text: string } | null

/** Whether the box speaks another protocol than these screens. */
function otherProtocol(box: BoxBuild): boolean {
  return box.protocolVersion !== undefined && box.protocolVersion !== PROTOCOL_VERSION
}

/**
 * Whether the box runs another build than these screens: another version,
 * where both know which build they are (lib/pwa.ts, knownBuild), or another
 * protocol.
 */
export function otherBuild(box: BoxBuild): boolean {
  const version = box.serverVersion
  const builds =
    !!version && version !== APP_VERSION && knownBuild(version) && knownBuild(APP_VERSION)
  return builds || otherProtocol(box)
}

/** A version as crew read it, without the commit a build carries. */
const shown = (version: string): string => version.replace(/\+.*$/, '')

/**
 * What to offer for the app's answer about the box's screens.
 *
 * Its screens, whenever the app has them and they aren't these: a reload
 * that changes nothing is never offered. A note only where there is
 * something to do about it. Screens that need a newer app say so. Anything
 * else leaves these screens running, which is nothing to say while the box
 * speaks their protocol, and otherwise the note says which of the two to
 * update, and why the app can't just run the box's screens instead.
 */
export function offerFrom(answer: ScreensAnswer, box: BoxBuild): ScreensOffer {
  if (answer.result === 'ready' || answer.result === 'same') {
    const version = answer.version
    return version && version !== APP_VERSION ? { kind: 'switch', version } : null
  }
  const runs = `This box runs crewbox ${shown(answer.version ?? box.serverVersion ?? '')}`
  const other = otherProtocol(box)
  if (answer.result === 'incompatible') {
    if (answer.update === 'app') {
      return {
        kind: 'note',
        text: other
          ? `${runs}, newer than this app can use. Update the app.`
          : `${runs}, whose screens need a newer app. Update the app to use them.`,
      }
    }
    return other
      ? { kind: 'note', text: `${runs}, older than this app can use. Update the box.` }
      : null
  }
  if (!other) return null
  const newer = (box.protocolVersion ?? 0) > PROTOCOL_VERSION
  const why =
    answer.result === 'unsigned'
      ? 'has no screens from a crewbox release for the app to run instead'
      : 'the app couldn’t get its screens to run instead'
  return {
    kind: 'note',
    text:
      `${runs}, ${newer ? 'newer' : 'older'} than this app can use, and ${why}. ` +
      `Update the ${newer ? 'app' : 'box'}.`,
  }
}

/** The app's answers this load, by what was asked: the same question gets the same answer. */
const answers = new Map<string, Promise<ScreensAnswer>>()

/**
 * What the app answers of the screens of the box at `origin`, asked once a
 * load for each build it says it runs. One that failed is asked again: the
 * network may do better next time.
 */
function answerFor(origin: string, box: BoxBuild): Promise<ScreensAnswer> {
  const key = JSON.stringify([origin, box.serverVersion ?? null, box.protocolVersion ?? null])
  const known = answers.get(key)
  if (known) return known
  const screens = nativeScreens()
  const answer: Promise<ScreensAnswer> = screens
    ? screens.prepare({ origin }).catch((error: unknown) => ({
        result: 'failed',
        reason: String(error),
      }))
    : Promise.resolve({ result: 'failed', reason: 'this app keeps no screens' })
  answers.set(key, answer)
  void answer.then(({ result }) => {
    if (result === 'failed') answers.delete(key)
  })
  return answer
}

/** Which welcome is the latest: an answer to any other is no longer news. */
let welcomes = 0

/**
 * In the apps, what a welcome from the box at `origin` offers of its
 * screens, given to `show` once the app has answered, unless another welcome
 * has come meanwhile. A box running these screens' build offers nothing,
 * and `show` hears that at once.
 */
export function screensAfterWelcome(
  origin: string,
  box: BoxBuild,
  show: (offer: ScreensOffer) => void
): void {
  const welcome = ++welcomes
  if (!otherBuild(box)) {
    show(null)
    return
  }
  void answerFor(origin, box).then((answer) => {
    if (welcome === welcomes) show(offerFrom(answer, box))
  })
}

/** How long opening another event waits for the app to have its box's screens. */
export const SCREENS_WAIT_MS = 10_000

/** How long opening another event waits for its box to answer at all. */
export const BOX_WAIT_MS = 3000

const WAITED = Symbol('waited')

/** `promise`, or WAITED once `ms` have gone by first. */
function within<T>(ms: number, promise: Promise<T>): Promise<T | typeof WAITED> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(WAITED), ms)
    void promise.then((value) => {
      clearTimeout(timer)
      resolve(value)
    })
  })
}

/**
 * In the apps, before the page reloads into another event: have the app
 * serve the screens it should open on. Its box's, when the box at `origin`
 * answers as that event within BOX_WAIT_MS and the app has or gets its
 * screens within SCREENS_WAIT_MS. Otherwise what the event last started with,
 * when the app still runs them, or the app's own.
 *
 * Settles once the app serves what the reload loads, and never rejects. The
 * app does one thing at a time, so a switch asked for while it is still
 * fetching would wait for the fetch, and could land after the reload, under
 * screens it wasn't meant for. So nothing is asked after a fetch that takes
 * too long: the reload loads what runs now, and the event's welcome offers
 * its box's screens once the app has them.
 */
export async function screensForEvent(event: string, origin: string | undefined): Promise<void> {
  const screens = isNative() ? nativeScreens() : undefined
  if (!screens) return
  let version: string | undefined
  if (origin) {
    const config = await getConfigAt(origin, AbortSignal.timeout(BOX_WAIT_MS)).catch(() => null)
    if (config && eventIdFrom(config.eventId) === event) {
      const answer = await within(
        SCREENS_WAIT_MS,
        screens.prepare({ origin }).catch(() => null)
      )
      if (answer === WAITED) return
      if (answer?.result === 'ready' || answer?.result === 'same') version = answer.version
    }
  }
  if (version) {
    try {
      await screens.use({ event, version })
      return
    } catch {
      // Gone since the app answered: what the event would start with instead.
    }
  }
  await screens.use({ event }).catch(() => {})
}

/**
 * Have the app serve `version` for `event` from the next load, for the update
 * pill. Rejects, and the app changes nothing, when it won't run them after
 * all.
 */
export async function switchScreens(event: string, version: string): Promise<void> {
  const screens = nativeScreens()
  if (!screens) throw new Error('This app keeps no screens')
  await screens.use({ event, version })
}
