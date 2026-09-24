// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Which event a device's storage belongs to.
 *
 * The names are the part that reaches phones in the field: a phone updated
 * in the middle of an event has to open exactly what it had, and a second
 * event must never open the first one's. Each test loads the module afresh,
 * the way a page load does, because the open event is fixed for a page's
 * life.
 */

type Scope = typeof import('./eventScope.ts')

/** A page load: the module as a fresh page would first evaluate it. */
async function load(): Promise<Scope> {
  vi.resetModules()
  return import('./eventScope.ts')
}

/** Everything the app has ever called its storage, as it always has. */
const TODAYS_NAMES = [
  'crewbox',
  'crewbox:token',
  'crewbox:event-name',
  'crewbox:wifi-ssid',
  'crewbox:modules',
  'crewbox:patch-sheets',
  'crewbox:lighting-docs',
  'crewbox:video-docs',
  'crewbox:patch-seen',
  'crewbox:lighting-seen',
  'crewbox:video-screens-seen',
  'crewbox:incident-outbox',
  'crewbox:incident-stage',
  'crewbox-patch-sheet-abc123',
  'crewbox-patch-index',
  'crewbox-lighting-plot-abc123',
  'crewbox-video-screens-abc123',
  'crewbox-timetable-event',
]

beforeEach(() => localStorage.clear())
afterEach(() => localStorage.clear())

describe('a phone that has only ever known one event', () => {
  it('keeps today’s names before it has been told any event', async () => {
    const scope = await load()
    expect(scope.openEvent()).toBeNull()
    for (const name of TODAYS_NAMES) expect(scope.storageName(name)).toBe(name)
  })

  it('opens exactly what it had after an update in the middle of an event', async () => {
    // What every phone in the field already has: the ID of the database its
    // cache came from, written on every welcome.
    localStorage.setItem('crewbox:db-epoch', 'friday')
    const scope = await load()
    expect(scope.openEvent()).toBe('friday')
    for (const name of TODAYS_NAMES) expect(scope.storageName(name)).toBe(name)
  })

  it('gives today’s names to the first event it is told of', async () => {
    const scope = await load()
    expect(scope.acceptEvent('friday')).toBe(true)
    expect(scope.openEvent()).toBe('friday')
    expect(localStorage.getItem('crewbox:db-epoch')).toBe('friday')
    for (const name of TODAYS_NAMES) expect(scope.storageName(name)).toBe(name)
    // And so does the next page load.
    const next = await load()
    expect(next.openEvent()).toBe('friday')
    for (const name of TODAYS_NAMES) expect(next.storageName(name)).toBe(name)
  })
})

describe('a box saying which event it is', () => {
  it('is the open event on every reconnect', async () => {
    localStorage.setItem('crewbox:db-epoch', 'friday')
    const scope = await load()
    expect(scope.acceptEvent('friday')).toBe(true)
    expect(scope.acceptEvent('friday')).toBe(true)
  })

  it('is taken as it always was when it is too old to say', async () => {
    // A box that predates event IDs sends none. That is not evidence of a
    // different event, and nothing is written.
    const scope = await load()
    expect(scope.acceptEvent(undefined)).toBe(true)
    expect(scope.openEvent()).toBeNull()
    expect(localStorage.getItem('crewbox:db-epoch')).toBeNull()
  })

  it('is refused when it is another event, and nothing is claimed or renamed', async () => {
    // A spare box with a fresh database, at the address this phone knows.
    localStorage.setItem('crewbox:db-epoch', 'friday')
    const scope = await load()
    expect(scope.acceptEvent('spare')).toBe(false)
    expect(scope.openEvent()).toBe('friday')
    expect(localStorage.getItem('crewbox:db-epoch')).toBe('friday')
    expect(scope.storageName('crewbox:token')).toBe('crewbox:token')
  })
})

describe('a second event', () => {
  it('has names of its own for everything', async () => {
    localStorage.setItem('crewbox:db-epoch', 'friday')
    const first = await load()
    first.chooseEvent('saturday')
    // Chosen, but this page goes on with what it has open until it reloads,
    // so nothing read from one event is written into the other's.
    expect(first.openEvent()).toBe('friday')
    expect(first.storageName('crewbox:token')).toBe('crewbox:token')

    const scope = await load()
    expect(scope.openEvent()).toBe('saturday')
    expect(scope.storageName('crewbox:token')).toBe('crewbox@saturday:token')
    expect(scope.storageName('crewbox')).toBe('crewbox@saturday')
    expect(scope.storageName('crewbox-patch-sheet-abc123')).toBe(
      'crewbox@saturday-patch-sheet-abc123'
    )
    expect(scope.storageName('crewbox-timetable-event')).toBe('crewbox@saturday-timetable-event')
  })

  it('can never land on one of today’s names, or another event’s', async () => {
    localStorage.setItem('crewbox:db-epoch', 'friday')
    const scope = await load()
    const saturday = TODAYS_NAMES.map((name) => scope.storageNameFor('saturday', name))
    const sunday = TODAYS_NAMES.map((name) => scope.storageNameFor('sunday', name))
    for (const name of [...saturday, ...sunday]) expect(TODAYS_NAMES).not.toContain(name)
    for (const name of saturday) expect(sunday).not.toContain(name)
    expect(new Set(saturday).size).toBe(TODAYS_NAMES.length)
  })

  it('leaves the first event its names while it is open', async () => {
    localStorage.setItem('crewbox:db-epoch', 'friday')
    localStorage.setItem('crewbox:event', 'saturday')
    const scope = await load()
    expect(scope.storageNameFor('friday', 'crewbox:token')).toBe('crewbox:token')
    expect(scope.storagePrefixFor('friday')).toBeNull()
    expect(scope.storagePrefixFor('saturday')).toBe('crewbox@saturday')
  })

  it('is not given today’s names when the first event has gone', async () => {
    // Once the first event is forgotten its names stay empty: an event that
    // already has names of its own keeps them, and so does the next one.
    localStorage.setItem('crewbox:db-epoch', 'friday')
    localStorage.setItem('crewbox:event', 'saturday')
    const scope = await load()
    scope.releaseEvent('friday')
    expect(localStorage.getItem('crewbox:db-epoch')).toBeNull()
    const next = await load()
    expect(next.openEvent()).toBe('saturday')
    expect(next.storageName('crewbox:token')).toBe('crewbox@saturday:token')
    expect(next.acceptEvent('sunday')).toBe(false)
    expect(next.storageNameFor('sunday', 'crewbox:token')).toBe('crewbox@sunday:token')
  })

  it('leaves a device that has forgotten every event as new', async () => {
    localStorage.setItem('crewbox:db-epoch', 'friday')
    const scope = await load()
    scope.releaseEvent('friday')
    const next = await load()
    expect(next.openEvent()).toBeNull()
    expect(next.acceptEvent('sunday')).toBe(true)
    expect(next.storageName('crewbox:token')).toBe('crewbox:token')
  })

  it('reads and writes its own settings, and not the first event’s', async () => {
    localStorage.setItem('crewbox:db-epoch', 'friday')
    localStorage.setItem('crewbox:event', 'saturday')
    localStorage.setItem('crewbox:token', 'fridays-sign-in')
    const scope = await load()
    expect(scope.readEventPref('crewbox:token')).toBeNull()
    scope.writeEventPref('crewbox:token', 'saturdays-sign-in')
    expect(localStorage.getItem('crewbox:token')).toBe('fridays-sign-in')
    expect(localStorage.getItem('crewbox@saturday:token')).toBe('saturdays-sign-in')
    scope.forgetEventPref('crewbox:token')
    expect(localStorage.getItem('crewbox@saturday:token')).toBeNull()
    expect(localStorage.getItem('crewbox:token')).toBe('fridays-sign-in')
  })
})

describe('the events a device knows', () => {
  it('keeps what it is not told again', async () => {
    const scope = await load()
    scope.rememberEvent({ id: 'friday', name: 'Harbour Fest', origin: 'http://10.0.0.2' })
    scope.rememberEvent({ id: 'friday', seenAt: 5 })
    expect(scope.knownEvents()).toEqual([
      { id: 'friday', name: 'Harbour Fest', origin: 'http://10.0.0.2', seenAt: 5 },
    ])
    // And across a page load.
    const next = await load()
    expect(next.knownEvent('friday')?.name).toBe('Harbour Fest')
  })

  it('forgets one, and what pointed at it', async () => {
    const scope = await load()
    scope.rememberEvent({ id: 'friday', name: '', origin: 'http://10.0.0.2' })
    scope.rememberEvent({ id: 'friday', replacedBy: 'spare', moveAnswered: true })
    scope.rememberEvent({ id: 'spare', name: '', origin: 'http://10.0.0.2' })
    scope.forgetEventRecord('spare')
    expect(scope.knownEvents()).toEqual([
      { id: 'friday', name: '', origin: 'http://10.0.0.2', seenAt: 0 },
    ])
  })

  it('stops asking about moving an event’s work once asked, and forgets the link once done', async () => {
    const scope = await load()
    scope.rememberEvent({ id: 'friday', name: '', origin: 'http://10.0.0.2' })
    scope.rememberEvent({ id: 'friday', replacedBy: 'spare' })
    // "Not now", or a move that left something a later one could bring.
    scope.answerMove('friday', false)
    expect(scope.knownEvent('friday')).toMatchObject({ replacedBy: 'spare', moveAnswered: true })
    // Everything that could come has.
    scope.answerMove('friday', true)
    expect(scope.knownEvent('friday')).toEqual({
      id: 'friday',
      name: '',
      origin: 'http://10.0.0.2',
      seenAt: 0,
    })
    // An event it has never heard of is no answer to anything.
    scope.answerMove('nobody', true)
    expect(scope.knownEvents()).toHaveLength(1)
  })

  it('reads junk in the slot as nothing known', async () => {
    localStorage.setItem('crewbox:boxes', '{not json')
    expect((await load()).knownEvents()).toEqual([])
    localStorage.setItem('crewbox:boxes', JSON.stringify([{ id: 5 }, 'x', null]))
    expect((await load()).knownEvents()).toEqual([])
  })

  it('tells a listener when it changes, and not when nothing did', async () => {
    const scope = await load()
    const heard = vi.fn()
    const stop = scope.subscribeKnownEvents(heard)
    scope.rememberEvent({ id: 'friday', name: 'Harbour Fest', origin: '' })
    scope.rememberEvent({ id: 'friday', name: 'Harbour Fest' })
    expect(heard).toHaveBeenCalledTimes(1)
    stop()
    scope.rememberEvent({ id: 'friday', name: 'Renamed' })
    expect(heard).toHaveBeenCalledTimes(1)
  })
})

describe('an event ID from a box', () => {
  it('is taken as the box mints it', async () => {
    const { eventIdFrom } = await load()
    expect(eventIdFrom('mfxk2a1b0c3d4e5f6g7h8')).toBe('mfxk2a1b0c3d4e5f6g7h8')
    expect(eventIdFrom('Friday_2026')).toBe('Friday_2026')
  })

  it('is no ID at all when it could not be one', async () => {
    // It goes into storage names, where a "-" or ":" would make one event's
    // names read as the start of another's.
    const { eventIdFrom } = await load()
    for (const junk of ['', 'a-b', 'a:b', 'a/b', 'a b', 'x'.repeat(65), 5, null, undefined, {}]) {
      expect(eventIdFrom(junk)).toBeUndefined()
    }
  })
})

describe('finding all of one event’s storage', () => {
  it('counts every database of today’s as the first event’s, and no other event’s', async () => {
    localStorage.setItem('crewbox:db-epoch', 'friday')
    const { isEventDatabase } = await load()
    for (const name of ['crewbox', 'crewbox-timetable-event', 'crewbox-patch-sheet-abc123']) {
      expect(isEventDatabase(name, 'friday')).toBe(true)
      expect(isEventDatabase(name, 'saturday')).toBe(false)
    }
    expect(isEventDatabase('crewbox@saturday', 'friday')).toBe(false)
    expect(isEventDatabase('workbox-expiration', 'friday')).toBe(false)
  })

  it('never takes one event’s databases for another whose ID starts the same', async () => {
    localStorage.setItem('crewbox:db-epoch', 'friday')
    const { isEventDatabase } = await load()
    expect(isEventDatabase('crewbox@sat', 'sat')).toBe(true)
    expect(isEventDatabase('crewbox@sat-patch-sheet-abc123', 'sat')).toBe(true)
    expect(isEventDatabase('crewbox@saturday', 'sat')).toBe(false)
    expect(isEventDatabase('crewbox@saturday-patch-sheet-abc123', 'sat')).toBe(false)
  })

  it('finds the first event’s settings by name, leaving the device’s alone', async () => {
    localStorage.setItem('crewbox:db-epoch', 'friday')
    const { eventPrefKeys, DEVICE_PREF_KEYS } = await load()
    const keys = [
      'crewbox:token',
      'crewbox:incident-outbox',
      ...DEVICE_PREF_KEYS,
      'crewbox@sat:token',
    ]
    expect(eventPrefKeys('friday', keys).sort()).toEqual(
      ['crewbox:incident-outbox', 'crewbox:token'].sort()
    )
  })

  it('finds any other event’s by its own prefix', async () => {
    localStorage.setItem('crewbox:db-epoch', 'friday')
    const { eventPrefKeys } = await load()
    const keys = [
      'crewbox:token',
      'crewbox@sat:token',
      'crewbox@sat:modules',
      'crewbox@saturday:token',
    ]
    expect(eventPrefKeys('sat', keys)).toEqual(['crewbox@sat:token', 'crewbox@sat:modules'])
  })

  it('has no setting that is both an event’s and the device’s', async () => {
    const { EVENT_PREF_KEYS, DEVICE_PREF_KEYS } = await load()
    for (const key of EVENT_PREF_KEYS) expect(DEVICE_PREF_KEYS).not.toContain(key)
  })
})
