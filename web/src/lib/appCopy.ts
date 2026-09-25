import {
  eventIdFrom,
  eventRecords,
  holdEvents,
  knownEvent,
  nextEvent,
  putBackEvents,
  storageNameFor,
  subscribeEventRecords,
  type EventRecord,
} from './eventScope.ts'
import { holdWhileOpen, readPref, writePref } from './prefs.ts'
import { isNative, nativeRecords, putBackServerOrigin, serverOrigin } from './server.ts'
import { TOKEN_KEY } from './sessions.ts'

/**
 * The apps' copy of what only this phone has, in files of the app's own
 * (native RecordsPlugin), so that a wipe of the web view's storage doesn't
 * take it with the rest.
 *
 * Web storage can go without anyone asking, on both phones, and each way it
 * goes takes a whole store at once. On an iPhone, WebKit's tracking
 * prevention deletes all of it once the page has gone without a tap for 7
 * days of use on iOS 17, or 30 on iOS 18 and later, open page or not. On
 * Android, Chromium deletes all of the app's IndexedDB when free space dips
 * into a narrow band, and remakes its localStorage after more than 8 failed
 * writes in a row. Both were read in the browsers' source and haven't been
 * seen on a phone. Crew tap the app all day, so the phone at risk is one
 * left showing the running order.
 *
 * What a wipe took from that phone was more than a cache. It forgot every
 * box it knew and the key it pinned for each, so the next join trusted
 * whichever box answered first. It forgot which event has today's storage
 * names, so the next event joined was given the first one's data. And it
 * was signed out of every event: the page's storage names each sign-in the
 * app keeps, and one it doesn't name goes (lib/sessions.ts), because the
 * page can't tell a wipe from an iPhone reinstall, whose Keychain outlives
 * the app.
 *
 * So the app keeps a record of each event, a file each: its entry in the
 * list, key and all, whether it has today's names, and when this phone last
 * opened it. At each start the page reads them before anything reads a
 * sign-in.
 *
 * - With `crewbox:copied-to-app`, the page's storage is the one the copy was
 *   made from, and nothing has wiped it since. It is the truth, and the
 *   app's copy is brought into line with it.
 * - Without it, the page's storage has been wiped, or this is the first
 *   start since the apps kept a copy. Whatever it lacks comes back: an
 *   event, a key, today's names, the open event and its box's address. A
 *   sign-in the app keeps is named again when a record names its event. An
 *   app deleted and installed again has no records, since that removes the
 *   app's files though not the Keychain, so its old sign-ins still go.
 *
 * On an iPhone the wipe comes while the app is open, so the page also holds
 * on to its box, its event's names and its sign-ins for as long as it is
 * open (lib/server.ts, lib/eventScope.ts, lib/sessions.ts). The mark goes
 * with the rest, and the page doesn't make it again: the next start finds
 * it missing and puts back what went.
 *
 * The files stay out of backups, as the sign-ins do: what they hold is one
 * phone's. On an iPhone that is only guidance, and a restore may bring
 * them back, with the page's storage and its mark: the copy is then brought
 * into line with the page's storage, as ever. They hold no token, so they
 * sign nothing in.
 */

/** The slot each event's record is kept in. It reaches phones, as the folder it is in does. */
const SLOT = 'event'

/** See above. It reaches phones: a new name would read as a wipe on every one of them, once. */
const COPIED = 'crewbox:copied-to-app'

/**
 * The longest a start waits for the app's records, as for its sign-ins
 * (lib/sessions.ts). The files answer in milliseconds; this is for a bridge
 * that never does.
 */
const LOAD_WAIT_MS = 5000

/**
 * An event's record as the app keeps it: when this phone last opened it, by
 * its own clock, besides what the page keeps. Anything else in it was put
 * there by a later version of the page, and is kept as it is.
 */
type Kept = EventRecord & { openedAt?: number } & Record<string, unknown>

/** Each event's record as the app has it, as far as this page knows: read at the start, and as written since. */
const kept = new Map<string, Kept>()

/**
 * Whether this page read the app's records at its start. A page that
 * couldn't doesn't know what the app holds, so it leaves the copy alone: the
 * next start reads it and puts back whatever this one lacked.
 */
let loaded = false

/**
 * Whether this page makes the mark, once the copy is first complete: a page
 * that started without it, and only then. Later on the page's storage may
 * have been wiped underneath it, and a mark made then would tell the next
 * start that what was left is the truth.
 */
let markDue = false

function parse(text: string): Kept | null {
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Kept) : null
  } catch {
    return null
  }
}

function openedAt(record: Kept | undefined): number {
  const at = record?.openedAt
  return typeof at === 'number' && Number.isFinite(at) ? at : 0
}

/** The event this phone opened last, by the records: the one to open after a wipe. */
function lastOpened(): string | null {
  let last: string | null = null
  for (const [id, record] of kept) {
    if (openedAt(record) > 0 && (last === null || openedAt(record) > openedAt(kept.get(last)))) {
      last = id
    }
  }
  return last
}

function waitFor<T>(answer: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    answer,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('no answer')), LOAD_WAIT_MS)
    }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * Put back whatever of this phone's events a wipe of the web view's storage
 * took, from the app's copy, before anything reads a sign-in: main.tsx
 * renders once this settles. At once anywhere but the apps, and in an app
 * too old to keep a copy.
 *
 * Settles to the sign-ins the app's records vouch for: those of events it
 * holds a record of, which lib/sessions.ts keeps though the page's storage
 * no longer names them. None unless the page's storage was wiped. Null when
 * the app keeps records and they couldn't be read: then nobody can say
 * whether a sign-in the page's storage doesn't name is from before a wipe or
 * before a reinstall, and it stays where it is for a start that can.
 *
 * Putting back today's names, the open event or the box's address reloads
 * the page instead, since everything evaluated so far was named without
 * them. The next load finds them in place and goes on.
 */
export async function restoreFromApp(): Promise<ReadonlySet<string> | null> {
  if (!isNative()) return new Set()
  // From now on this page holds on to its box, its event's names and its
  // sign-ins, whatever happens to the web view's storage underneath it: as
  // they are now, and as the page changes them.
  holdWhileOpen()
  holdEvents()
  serverOrigin()
  const app = nativeRecords()
  if (!app) return new Set()
  let values: Record<string, string>
  try {
    values = (await waitFor(app.readAll({ slot: SLOT }))).values ?? {}
  } catch {
    return null
  }
  kept.clear()
  for (const [id, text] of Object.entries(values)) {
    const record = eventIdFrom(id) && typeof text === 'string' ? parse(text) : null
    if (record) kept.set(id, record)
  }
  loaded = true
  if (readPref(COPIED) !== null) return new Set()
  markDue = true

  const records = new Map<string, EventRecord>()
  for (const [id, record] of kept) {
    records.set(id, { known: record.known, todaysNames: record.todaysNames === true })
  }
  let reload = putBackEvents(records, lastOpened())
  const open = nextEvent()
  const origin = open ? knownEvent(open)?.origin : undefined
  if (origin && putBackServerOrigin(origin)) reload = true
  if (reload) {
    location.reload()
    return new Promise(() => {})
  }
  return new Set([...records.keys()].map((id) => storageNameFor(id, TOKEN_KEY)))
}

/** Settles once the app's copy is as the page's storage was when it was asked. */
let copying: Promise<void> = Promise.resolve()

/** Bring the app's copy into line with the page's storage. Nothing to do anywhere but the apps. */
export function copyToApp(): Promise<void> {
  copying = copying.then(copyOnce, copyOnce)
  return copying
}

async function copyOnce(): Promise<void> {
  const app = isNative() ? nativeRecords() : undefined
  if (!app || !loaded) return
  const mark = markDue
  markDue = false
  const records = eventRecords()
  const open = nextEvent()
  // The open event is the one opened last, so that a wipe opens it again.
  let latest = 0
  for (const [id, record] of kept)
    if (id !== open && records.has(id)) latest = Math.max(latest, openedAt(record))
  let complete = true
  for (const [id, record] of records) {
    const before = kept.get(id)
    let at: number | undefined = openedAt(before) || undefined
    if (id === open && openedAt(before) <= latest) at = Math.max(Date.now(), latest + 1)
    const next: Kept = {
      ...before,
      known: record.known,
      todaysNames: record.todaysNames || undefined,
      openedAt: at,
    }
    if (before && JSON.stringify(before) === JSON.stringify(next)) continue
    try {
      await app.write({ event: id, slot: SLOT, value: JSON.stringify(next) })
      kept.set(id, next)
    } catch {
      complete = false
    }
  }
  for (const id of [...kept.keys()]) {
    if (records.has(id)) continue
    try {
      await app.remove({ event: id })
      kept.delete(id)
    } catch {
      complete = false
    }
  }
  if (complete && mark) writePref(COPIED, '1')
}

/**
 * Keep the app's copy in step with the page's storage from now on: at once,
 * and whenever an event is listed, changed, opened or forgotten.
 */
export function keepAppCopy(): void {
  if (!loaded) return
  subscribeEventRecords(() => void copyToApp())
  void copyToApp()
}
