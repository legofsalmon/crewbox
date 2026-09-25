import { storageName } from './eventScope.ts'
import { forgetPref, readPref, writePref } from './prefs.ts'
import { isNative, nativeSessions, type SessionsPlugin } from './server.ts'

/**
 * Where this device keeps its sign-ins: one session token per event, under
 * the event's storage name, `crewbox:token` or `crewbox@<event>:token`
 * (eventScope.ts).
 *
 * In a browser that is the page's localStorage, as it always was. In the
 * apps the token is the app's, not the web view's (native SessionsPlugin): in
 * the iPhone's Keychain, where it never goes to another phone, and on Android
 * sealed with a key the phone's Keystore holds, which never leaves it, in a
 * file the app's backup rules leave out. The web view's storage is the part
 * of an app that travels. Android's backups and its phone-to-phone transfer
 * copied it to a new phone, and an iCloud backup takes it to one, which then
 * arrived holding a sign-in made on the old phone. Android's alerts service
 * reads the app's copy too, when Android restarts it, so there is one copy of
 * each sign-in at rest, not two.
 *
 * The page's storage still says which sign-ins there are: under each name it
 * keeps `HELD`, which no token can be, in place of the token. So whatever
 * finds an event's settings by name finds its sign-in as before, and at each
 * start the two check each other:
 *
 * - A sign-in the app keeps that the page's storage doesn't name is from
 *   before that storage was cleared: the app deleted and installed again on
 *   an iPhone, whose Keychain outlives the app, or WebKit clearing a phone
 *   short of space. It goes, as the rest of that storage went. Kept, it
 *   would have signed a fresh install in with no box to go to.
 * - A name with nothing behind it came to this phone in a backup, without
 *   its token. The phone is not signed in to that event, and says so.
 * - A token still in the page's storage, from before this, moves across, and
 *   its box renews it ({@link renewCarried}): a copy of it may have gone to
 *   another phone in a backup made before, where the app would move it
 *   across just the same.
 */

/**
 * What the page's storage holds in place of a token the app keeps.
 *
 * A token is base64url, which has no brackets or spaces, so no token is ever
 * this. It reaches phones, and renaming it would sign every one of them out.
 */
export const HELD = '(kept by the app)'

/** The open event's sign-in is under this name, as eventScope names it. */
export const TOKEN_KEY = 'crewbox:token'

/** A sign-in's storage name: the first event's, or any other's. */
const SESSION_NAME = /^crewbox(?:@[0-9A-Za-z_]{1,64})?:token$/

/**
 * The longest the page waits for the app's sign-ins before starting without
 * them, as if signed out, rather than on a blank screen. A Keychain or a
 * Keystore answers in milliseconds; this is for a bridge that never does.
 */
const LOAD_WAIT_MS = 5000

/** The tokens the app keeps, by name, as the page last heard. */
const held = new Map<string, string>()

/**
 * The sign-ins the app moved out of the page's storage whose box hasn't yet
 * renewed them ({@link renewCarried}), by name. Names, not tokens: a copy of
 * this that travels says nothing on a phone without them. It reaches phones,
 * and renaming it would leave theirs unrenewed.
 */
const CARRIED = 'crewbox:carried-sign-ins'

/** A box's token, as it makes them: base64url, which HELD can never be. */
const TOKEN = /^[A-Za-z0-9_-]{16,256}$/

function carried(): string[] {
  try {
    const names: unknown = JSON.parse(readPref(CARRIED) ?? '[]')
    return Array.isArray(names)
      ? names.filter((name): name is string => typeof name === 'string' && isSessionName(name))
      : []
  } catch {
    return []
  }
}

function setCarried(names: string[]): void {
  if (names.length > 0) writePref(CARRIED, JSON.stringify([...new Set(names)]))
  else forgetPref(CARRIED)
}

function uncarry(name: string): void {
  const names = carried()
  if (names.includes(name)) setCarried(names.filter((other) => other !== name))
}

function app(): SessionsPlugin | undefined {
  return isNative() ? nativeSessions() : undefined
}

function localStorageKeys(): string[] {
  try {
    return Object.keys(localStorage)
  } catch {
    return []
  }
}

/** Whether a storage name is a sign-in's, for any event. */
export function isSessionName(name: string): boolean {
  return SESSION_NAME.test(name)
}

/**
 * Take the app's sign-ins, before anything asks for one: main.tsx renders
 * once this settles. At once anywhere but the apps, or in an app too old to
 * keep them, where the page's storage has them as before.
 *
 * An app that doesn't answer (an iPhone not unlocked since it started, or a
 * Keystore that won't) leaves this start signed out of events it keeps, and
 * deletes nothing: the next start that hears from it has them all.
 */
export async function loadSessions(): Promise<void> {
  const keeper = app()
  if (!keeper) return
  let sessions: Record<string, string>
  try {
    let timer: ReturnType<typeof setTimeout> | undefined
    const answer = await Promise.race([
      keeper.load(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('no answer')), LOAD_WAIT_MS)
      }),
    ]).finally(() => clearTimeout(timer))
    sessions = answer.sessions ?? {}
  } catch {
    return
  }
  held.clear()
  for (const [name, token] of Object.entries(sessions)) {
    if (readPref(name) === HELD && typeof token === 'string' && token) held.set(name, token)
    else await keeper.forget({ name }).catch(() => {})
  }
  for (const name of localStorageKeys().filter(isSessionName)) {
    const value = readPref(name)
    if (value === HELD) {
      if (!held.has(name)) {
        forgetPref(name)
        uncarry(name)
      }
    } else if (value) {
      await saveSession(name, value)
      // The app keeps it now, and it is still the token that was where
      // backups go, until its box swaps it.
      if (held.has(name)) setCarried([...carried(), name])
    }
  }
}

/**
 * Have its box renew a sign-in the app moved out of the page's storage, by
 * `renew`, before this device says hello with it.
 *
 * The page's storage is the part of an app that backups and phone-to-phone
 * transfers carry, so a sign-in that was ever there may have gone to another
 * phone, whose app moves it across as this one did. The box's new one stands
 * in for it, and the first time the new one is used the old one stops
 * working (server Store.renewSession): the copy signs nothing in, and one
 * phone keeps the sign-in. One the app couldn't keep, left in the page's
 * storage, is renewed once the app keeps it: until then a new one would be
 * kept there too.
 *
 * Anything but a new token changes nothing here, and the next start asks
 * again, with the old one working until then: a box that doesn't answer, or
 * doesn't in time, or another event's box at the address, which knows
 * nothing of the sign-in. One that has ended, or that another phone renewed
 * first, fails at hello, as it would have anyway.
 */
export async function renewCarried(
  name: string,
  renew: (token: string) => Promise<string>
): Promise<void> {
  const token = held.get(name)
  if (!token || !carried().includes(name)) return
  let next: unknown
  try {
    next = await renew(token)
  } catch {
    return
  }
  if (typeof next !== 'string' || !TOKEN.test(next)) return
  await saveSession(name, next)
  uncarry(name)
}

/** A sign-in's token, or null when this device isn't signed in to that event. */
export function readSession(name: string): string | null {
  const value = readPref(name)
  if (value !== HELD) return value
  return held.get(name) ?? null
}

/**
 * Keep a sign-in. Settles once it is kept, so a reload straight after keeps
 * it too.
 *
 * In the apps it goes to the app, and the page's storage keeps its name. An
 * app that can't keep it leaves it in the page's storage, as before, rather
 * than the crew member signed out.
 */
export async function saveSession(name: string, token: string): Promise<void> {
  const keeper = app()
  if (keeper) {
    try {
      await keeper.save({ name, token })
      held.set(name, token)
      writePref(name, HELD)
      return
    } catch {
      // Below: the page's storage.
    }
  }
  held.delete(name)
  writePref(name, token)
}

/** Forget a sign-in, wherever it is kept. Settles once it has gone. */
export async function forgetSession(name: string): Promise<void> {
  forgetPref(name)
  held.delete(name)
  uncarry(name)
  await app()
    ?.forget({ name })
    .catch(() => {})
}

/** The open event's sign-in, for anything that calls the box as this crew member. */
export function openSession(): string | null {
  return readSession(storageName(TOKEN_KEY))
}
