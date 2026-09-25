// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecordsPlugin, SessionsPlugin } from './server.ts'

/**
 * The apps' copy of this phone's events (appCopy.ts), and a page that holds
 * on while the web view's storage is wiped underneath it.
 *
 * The app's files are a map of folders here, and its Keychain a map of
 * sign-ins. Each start loads every module afresh, as a page load does, and
 * clearing localStorage is the wipe: WebKit's tracking prevention on an
 * iPhone, or Chromium remaking an Android phone's localStorage.
 */

type Modules = {
  copy: typeof import('./appCopy.ts')
  scope: typeof import('./eventScope.ts')
  sessions: typeof import('./sessions.ts')
  server: typeof import('./server.ts')
}

const FRIDAY = {
  id: 'friday',
  name: 'Harbour Fest',
  origin: 'http://10.0.0.2',
  seenAt: 5,
  key: 'fridays-key',
}
const SATURDAY = {
  id: 'saturday',
  name: 'Quay Night',
  origin: 'http://10.0.0.9',
  seenAt: 6,
  key: 'saturdays-key',
}
const FRIDAY_TOKEN = 'q5vX0TRw2mJ9cYh4Kz7LbN1uEoPsFgHi'
const SATURDAY_TOKEN = 'Zt8rUe3WqYp0oIi9uYt6rEe5wQq4aSsD'

/** The app: its files, folder by event, and its Keychain. `tooOld` has no files of its own. */
function app(
  options: {
    files?: Record<string, Record<string, string>>
    tokens?: Record<string, string>
    tooOld?: boolean
  } = {}
) {
  const folders = new Map(
    Object.entries(options.files ?? {}).map(([id, slots]) => [id, new Map(Object.entries(slots))])
  )
  const keychain = new Map(Object.entries(options.tokens ?? {}))
  const records = {
    folders,
    unreadable: false,
    readAll: vi.fn<RecordsPlugin['readAll']>(async ({ slot }) => {
      if (records.unreadable) throw new Error('The files answered nothing')
      const values: Record<string, string> = {}
      for (const [id, slots] of folders) {
        const value = slots.get(slot)
        if (value !== undefined) values[id] = value
      }
      return { values }
    }),
    write: vi.fn<RecordsPlugin['write']>(async ({ event, slot, value }) => {
      folders.set(event, (folders.get(event) ?? new Map<string, string>()).set(slot, value))
    }),
    remove: vi.fn<RecordsPlugin['remove']>(async ({ event, slot }) => {
      if (slot) folders.get(event)?.delete(slot)
      else folders.delete(event)
    }),
  }
  const sessions = {
    keychain,
    load: vi.fn<SessionsPlugin['load']>(async () => ({ sessions: Object.fromEntries(keychain) })),
    save: vi.fn<SessionsPlugin['save']>(async ({ name, token }) => {
      keychain.set(name, token)
    }),
    forget: vi.fn<SessionsPlugin['forget']>(async ({ name }) => {
      keychain.delete(name)
    }),
  }
  ;(window as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'ios',
    Plugins: options.tooOld
      ? { CrewboxSessions: sessions }
      : { CrewboxRecords: records, CrewboxSessions: sessions },
  }
  return { records, sessions }
}

/** What a record in the app's files says, parsed. */
function record(
  files: ReturnType<typeof app>['records'],
  id: string
): Record<string, unknown> | undefined {
  const text = files.folders.get(id)?.get('event')
  return text === undefined ? undefined : (JSON.parse(text) as Record<string, unknown>)
}

let reload: ReturnType<typeof vi.fn<() => void>>
let reloaded: (() => void) | undefined

/**
 * A start of the page, as main.tsx runs it: the app's copy, then the
 * sign-ins, then the copy kept in step. `reloaded` when the copy put back
 * something every module had already been named without.
 */
async function start(): Promise<Modules & { reloaded: boolean }> {
  vi.resetModules()
  const modules: Modules = {
    copy: await import('./appCopy.ts'),
    scope: await import('./eventScope.ts'),
    sessions: await import('./sessions.ts'),
    server: await import('./server.ts'),
  }
  const outcome = await Promise.race([
    modules.copy.restoreFromApp(),
    new Promise<'reloaded'>((resolve) => {
      reloaded = () => resolve('reloaded')
    }),
  ])
  if (outcome === 'reloaded') return { ...modules, reloaded: true }
  await modules.sessions.loadSessions(outcome)
  modules.copy.keepAppCopy()
  await modules.copy.copyToApp()
  return { ...modules, reloaded: false }
}

/** A phone signed in to Friday's box, as it is when this version first starts on it. */
function signedInToFriday(): void {
  localStorage.setItem('crewbox:db-epoch', 'friday')
  localStorage.setItem('crewbox:event', 'friday')
  localStorage.setItem('crewbox:boxes', JSON.stringify([FRIDAY]))
  localStorage.setItem('crewbox:server-url', FRIDAY.origin)
  localStorage.setItem('crewbox:token', '(kept by the app)')
}

beforeEach(() => {
  localStorage.clear()
  reload = vi.fn<() => void>(() => reloaded?.())
  vi.spyOn(window.location, 'reload').mockImplementation(reload)
})
afterEach(() => {
  delete (window as { Capacitor?: unknown }).Capacitor
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('in a browser', () => {
  it('has no copy to read or keep, and reads the page’s storage each time, as it always has', async () => {
    signedInToFriday()
    const { copy, server, scope } = await start()
    expect(await copy.restoreFromApp()).toEqual(new Set())
    localStorage.setItem('crewbox:server-url', 'http://10.0.0.3')
    expect(server.serverOrigin()).toBe('http://10.0.0.3')
    localStorage.clear()
    expect(server.serverOrigin()).toBe('')
    expect(scope.storageName('crewbox:modules')).toBe('crewbox:modules')
  })
})

describe('the app’s copy', () => {
  it('is made at the first start: each event’s entry, today’s names, and the open one', async () => {
    signedInToFriday()
    const { records } = app({ tokens: { 'crewbox:token': FRIDAY_TOKEN } })
    const { reloaded, sessions } = await start()
    expect(reloaded).toBe(false)
    expect(sessions.openSession()).toBe(FRIDAY_TOKEN)
    expect(record(records, 'friday')).toMatchObject({ known: FRIDAY, todaysNames: true })
    expect(record(records, 'friday')?.openedAt).toEqual(expect.any(Number))
    expect(localStorage.getItem('crewbox:copied-to-app')).toBe('1')
  })

  it('holds no token, and nothing but the events', async () => {
    signedInToFriday()
    const { records } = app({ tokens: { 'crewbox:token': FRIDAY_TOKEN } })
    await start()
    const all = [...records.folders.values()].flatMap((slots) => [...slots.values()]).join('')
    expect(all).not.toContain(FRIDAY_TOKEN)
    expect([...records.folders.keys()]).toEqual(['friday'])
    expect([...records.folders.get('friday')!.keys()]).toEqual(['event'])
  })

  it('follows the event opened last, and one forgotten', async () => {
    signedInToFriday()
    const { records } = app()
    const { scope, copy } = await start()
    scope.rememberEvent(SATURDAY)
    scope.chooseEvent('saturday')
    await copy.copyToApp()
    const friday = record(records, 'friday')!.openedAt as number
    const saturday = record(records, 'saturday')!.openedAt as number
    expect(saturday).toBeGreaterThan(friday)
    expect(record(records, 'saturday')).toMatchObject({ known: SATURDAY })
    expect(record(records, 'saturday')?.todaysNames).toBeUndefined()

    scope.releaseEvent('saturday')
    scope.forgetEventRecord('saturday')
    await copy.copyToApp()
    expect(records.folders.has('saturday')).toBe(false)
  })

  it('writes nothing again at a start where nothing changed', async () => {
    signedInToFriday()
    const { records } = app()
    await start()
    records.write.mockClear()
    await start()
    expect(records.write).not.toHaveBeenCalled()
    expect(records.remove).not.toHaveBeenCalled()
  })

  it('keeps what a later version of the page put in a record', async () => {
    signedInToFriday()
    localStorage.setItem('crewbox:copied-to-app', '1')
    const later = { known: FRIDAY, todaysNames: true, openedAt: 7, screens: { version: '2.0.0' } }
    const { records } = app({ files: { friday: { event: JSON.stringify(later) } } })
    const { scope, copy } = await start()
    scope.rememberEvent({ id: 'friday', name: 'Harbour Fest, day two' })
    await copy.copyToApp()
    expect(record(records, 'friday')).toMatchObject({
      known: { name: 'Harbour Fest, day two' },
      screens: { version: '2.0.0' },
      openedAt: 7,
    })
  })

  it('is left alone by a page that couldn’t read it, and read by the next', async () => {
    signedInToFriday()
    const { records } = app({ tokens: { 'crewbox:token': FRIDAY_TOKEN } })
    await start()
    localStorage.clear()
    records.unreadable = true
    records.write.mockClear()
    const blind = await start()
    expect(blind.reloaded).toBe(false)
    expect(records.write).not.toHaveBeenCalled()
    expect(records.remove).not.toHaveBeenCalled()
    expect(records.folders.has('friday')).toBe(true)
    expect(localStorage.getItem('crewbox:copied-to-app')).toBeNull()

    records.unreadable = false
    expect((await start()).reloaded).toBe(true)
    const { sessions, scope } = await start()
    expect(scope.openEvent()).toBe('friday')
    expect(sessions.openSession()).toBe(FRIDAY_TOKEN)
  })

  it('reads no record from a folder that isn’t an event’s, or one that isn’t a record', async () => {
    const { records } = app({
      files: {
        '../boxes': { event: JSON.stringify({ known: FRIDAY }) },
        friday: { event: '{junk' },
      },
    })
    const { reloaded, scope } = await start()
    expect(reloaded).toBe(false)
    expect(scope.knownEvents()).toEqual([])
    expect(records.folders.has('../boxes')).toBe(true)
  })
})

describe('after the page’s storage was wiped', () => {
  it('opens the phone as it was, still signed in, once the page has loaded again', async () => {
    signedInToFriday()
    const { sessions: keychain } = app({ tokens: { 'crewbox:token': FRIDAY_TOKEN } })
    await start()
    localStorage.clear()

    const first = await start()
    expect(first.reloaded).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)

    const { reloaded, sessions, scope, server } = await start()
    expect(reloaded).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(scope.openEvent()).toBe('friday')
    expect(scope.knownEvents()).toEqual([FRIDAY])
    expect(scope.storageName('crewbox:modules')).toBe('crewbox:modules')
    expect(server.serverOrigin()).toBe(FRIDAY.origin)
    expect(sessions.openSession()).toBe(FRIDAY_TOKEN)
    expect(localStorage.getItem('crewbox:token')).toBe(sessions.HELD)
    expect(keychain.forget).not.toHaveBeenCalled()
    expect(localStorage.getItem('crewbox:copied-to-app')).toBe('1')
  })

  it('has its box renew each sign-in it named again, since the wipe took the marks', async () => {
    signedInToFriday()
    app({ tokens: { 'crewbox:token': FRIDAY_TOKEN } })
    await start()
    localStorage.clear()
    await start()
    await start()
    expect(JSON.parse(localStorage.getItem('crewbox:carried-sign-ins') ?? '[]')).toEqual([
      'crewbox:token',
    ])
  })

  it('opens the event opened last, at its own box, and keeps every event’s sign-in', async () => {
    signedInToFriday()
    localStorage.setItem('crewbox@saturday:token', '(kept by the app)')
    app({ tokens: { 'crewbox:token': FRIDAY_TOKEN, 'crewbox@saturday:token': SATURDAY_TOKEN } })
    const before = await start()
    before.scope.rememberEvent(SATURDAY)
    before.server.setServerOrigin(SATURDAY.origin)
    before.scope.chooseEvent('saturday')
    await before.copy.copyToApp()
    localStorage.clear()

    expect((await start()).reloaded).toBe(true)
    const { scope, server, sessions } = await start()
    expect(scope.openEvent()).toBe('saturday')
    expect(scope.storageName('crewbox:modules')).toBe('crewbox@saturday:modules')
    expect(server.serverOrigin()).toBe(SATURDAY.origin)
    expect(sessions.openSession()).toBe(SATURDAY_TOKEN)
    expect(sessions.readSession('crewbox:token')).toBe(FRIDAY_TOKEN)
    expect(scope.knownEvent('saturday')?.key).toBe(SATURDAY.key)
  })

  it('puts back only what is missing, without loading again for the list alone', async () => {
    signedInToFriday()
    app({ tokens: { 'crewbox:token': FRIDAY_TOKEN } })
    await start()
    localStorage.removeItem('crewbox:boxes')
    localStorage.removeItem('crewbox:token')
    localStorage.removeItem('crewbox:copied-to-app')
    localStorage.setItem('crewbox:server-url', 'http://10.0.0.4')
    const { reloaded, scope, server, sessions } = await start()
    expect(reloaded).toBe(false)
    expect(scope.knownEvents()).toEqual([FRIDAY])
    expect(server.serverOrigin()).toBe('http://10.0.0.4')
    expect(sessions.openSession()).toBe(FRIDAY_TOKEN)
  })

  it('gives an event back the key it lost, and no other', async () => {
    signedInToFriday()
    app()
    await start()
    const { key: _, ...keyless } = FRIDAY
    localStorage.setItem('crewbox:boxes', JSON.stringify([keyless]))
    localStorage.removeItem('crewbox:copied-to-app')
    expect((await start()).scope.knownEvent('friday')?.key).toBe(FRIDAY.key)

    // A key the page's storage has is its own say, as ever (keepEventKey).
    localStorage.setItem('crewbox:boxes', JSON.stringify([{ ...FRIDAY, key: 'opened-anyway' }]))
    localStorage.removeItem('crewbox:copied-to-app')
    expect((await start()).scope.knownEvent('friday')?.key).toBe('opened-anyway')
  })
})

describe('an app deleted and installed again', () => {
  it('drops the sign-ins its Keychain outlived, with no copy to vouch for them', async () => {
    const { sessions: keychain } = app({ tokens: { 'crewbox:token': FRIDAY_TOKEN } })
    const { reloaded, sessions } = await start()
    expect(reloaded).toBe(false)
    expect(sessions.openSession()).toBeNull()
    expect(keychain.keychain.size).toBe(0)
  })
})

describe('a start where the page’s storage wasn’t wiped', () => {
  it('takes the page’s storage over the copy, which follows it', async () => {
    // Saturday was forgotten, and the app didn't hear before it was closed.
    signedInToFriday()
    localStorage.setItem('crewbox:copied-to-app', '1')
    const stale = JSON.stringify({ known: SATURDAY, openedAt: 9 })
    const { records, sessions: keychain } = app({
      files: {
        friday: { event: JSON.stringify({ known: FRIDAY, todaysNames: true, openedAt: 1 }) },
        saturday: { event: stale },
      },
      tokens: { 'crewbox:token': FRIDAY_TOKEN, 'crewbox@saturday:token': SATURDAY_TOKEN },
    })
    const { reloaded, scope } = await start()
    expect(reloaded).toBe(false)
    expect(scope.knownEvent('saturday')).toBeUndefined()
    expect(scope.openEvent()).toBe('friday')
    expect(records.folders.has('saturday')).toBe(false)
    expect(keychain.keychain.has('crewbox@saturday:token')).toBe(false)
    expect(keychain.keychain.get('crewbox:token')).toBe(FRIDAY_TOKEN)
  })

  it('leaves signed out a sign-in its crew member signed out of', async () => {
    signedInToFriday()
    const { sessions: keychain } = app({ tokens: { 'crewbox:token': FRIDAY_TOKEN } })
    const { sessions } = await start()
    // Signed out, and the app kept the token anyway, as a failed delete can.
    await sessions.forgetSession('crewbox:token')
    keychain.keychain.set('crewbox:token', FRIDAY_TOKEN)
    const next = await start()
    expect(next.sessions.openSession()).toBeNull()
    expect(keychain.keychain.has('crewbox:token')).toBe(false)
  })
})

describe('a page the storage is wiped underneath', () => {
  it('doesn’t take what the wipe left for the truth, then or at the next start', async () => {
    signedInToFriday()
    app({ tokens: { 'crewbox:token': FRIDAY_TOKEN } })
    const open = await start()
    localStorage.clear()
    open.scope.rememberEvent({ id: 'friday', seenAt: 8 })
    await open.copy.copyToApp()
    expect(localStorage.getItem('crewbox:copied-to-app')).toBeNull()

    expect((await start()).reloaded).toBe(true)
    const { scope, sessions } = await start()
    expect(scope.openEvent()).toBe('friday')
    expect(scope.knownEvent('friday')?.seenAt).toBe(8)
    expect(sessions.openSession()).toBe(FRIDAY_TOKEN)
  })

  it('makes the mark only once its copy is complete, at the start that found it missing', async () => {
    signedInToFriday()
    const { records } = app()
    records.write.mockRejectedValueOnce(new Error('The disk is full'))
    const { scope, copy } = await start()
    expect(localStorage.getItem('crewbox:copied-to-app')).toBeNull()
    scope.rememberEvent({ id: 'friday', seenAt: 8 })
    await copy.copyToApp()
    expect(record(records, 'friday')).toMatchObject({ known: { seenAt: 8 } })
    expect(localStorage.getItem('crewbox:copied-to-app')).toBeNull()
    await start()
    expect(localStorage.getItem('crewbox:copied-to-app')).toBe('1')
  })

  it('holds on to its box, its event’s names and its sign-in while it is open', async () => {
    signedInToFriday()
    app({ tokens: { 'crewbox:token': FRIDAY_TOKEN } })
    const { server, scope, sessions } = await start()
    localStorage.clear()
    expect(server.serverOrigin()).toBe(FRIDAY.origin)
    expect(scope.openEvent()).toBe('friday')
    expect(scope.storageName('crewbox:modules')).toBe('crewbox:modules')
    expect(scope.storageNameFor('friday', 'crewbox')).toBe('crewbox')
    expect(sessions.openSession()).toBe(FRIDAY_TOKEN)
  })

  it('still lets go of a sign-in signed out of, and a box set aside', async () => {
    signedInToFriday()
    app({ tokens: { 'crewbox:token': FRIDAY_TOKEN } })
    const { server, sessions } = await start()
    localStorage.clear()
    await sessions.forgetSession('crewbox:token')
    expect(sessions.openSession()).toBeNull()
    server.setServerOrigin('')
    expect(server.serverOrigin()).toBe('')
  })
})

describe('an app too old to keep a copy', () => {
  it('starts as before, and the page still holds on while it is open', async () => {
    signedInToFriday()
    const { sessions: keychain } = app({ tokens: { 'crewbox:token': FRIDAY_TOKEN }, tooOld: true })
    const { reloaded, server, sessions } = await start()
    expect(reloaded).toBe(false)
    expect(sessions.openSession()).toBe(FRIDAY_TOKEN)
    expect(localStorage.getItem('crewbox:copied-to-app')).toBeNull()
    localStorage.clear()
    expect(server.serverOrigin()).toBe(FRIDAY.origin)
    expect(keychain.keychain.get('crewbox:token')).toBe(FRIDAY_TOKEN)
  })
})

describe('unsent work', () => {
  const MESSAGE = { clientMsgId: 'doors', channelId: 'general', body: 'Doors in ten', createdAt: 1 }
  const ENTRY = {
    clientMsgId: 'barrier',
    kind: 'note',
    severity: 'note',
    body: 'Barrier moved at stage left',
    at: 1,
    stage: 'Main',
    actId: '',
    actName: '',
  }

  /** What one slot of the app's files holds, parsed. */
  function slot(files: ReturnType<typeof app>['records'], id: string, name: string): unknown {
    const text = files.folders.get(id)?.get(name)
    return text === undefined ? undefined : JSON.parse(text)
  }

  /**
   * An event's chat cache that answers once `answer` is called, and then as
   * `after` says: a read the page is part way through.
   */
  function slowChatCache(after: unknown[]) {
    let answer!: (messages: unknown[]) => void
    const first = new Promise<unknown[]>((resolve) => (answer = resolve))
    const storedOutboxOf = vi.fn(() => Promise.resolve(after)).mockReturnValueOnce(first)
    vi.doMock('./db.ts', async (importOriginal) => ({
      ...(await importOriginal<typeof import('./db.ts')>()),
      storedOutboxOf,
    }))
    return { answer: (messages: unknown[]) => answer(messages) }
  }

  /** The app's files, answering for unsent work after the records, as a start mustn't count on. */
  function unsentLast(records: ReturnType<typeof app>['records'], recordsToo?: 'unreadable'): void {
    const read = records.readAll.getMockImplementation()!
    records.readAll.mockImplementation(async (options) => {
      if (options.slot === 'event') {
        if (recordsToo) throw new Error('The files answered nothing')
        return read(options)
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
      return read(options)
    })
  }

  afterEach(() => {
    vi.doUnmock('./db.ts')
  })

  it('is held before the page renders, from the app’s files, whatever the page’s storage lost', async () => {
    // At the first start since the apps kept a copy, and at any other.
    for (const copied of [false, true]) {
      localStorage.clear()
      signedInToFriday()
      if (copied) localStorage.setItem('crewbox:copied-to-app', '1')
      const { records } = app({
        files: {
          friday: {
            outbox: JSON.stringify([MESSAGE]),
            'incident-outbox': JSON.stringify([ENTRY]),
          },
        },
      })
      unsentLast(records)
      vi.resetModules()
      const copy = await import('./appCopy.ts')
      const { cache } = await import('./db.ts')
      const { queuedIncidents } = await import('../modules/incident/model/outbox.ts')
      await copy.restoreFromApp()
      // None of it in the page's storage, which here has no chat cache at all.
      expect(localStorage.getItem('crewbox:incident-outbox')).toBeNull()
      expect(queuedIncidents()).toEqual([ENTRY])
      expect(await cache.loadOutbox()).toEqual([MESSAGE])
    }
  })

  it('is read though the records can’t be, and kept in step from then on', async () => {
    signedInToFriday()
    const { records } = app({ files: { friday: { outbox: JSON.stringify([MESSAGE]) } } })
    unsentLast(records, 'unreadable')
    vi.resetModules()
    const copy = await import('./appCopy.ts')
    const unsent = await import('./unsent.ts')
    expect(await copy.restoreFromApp()).toBeNull()
    expect(unsent.heldUnsent('friday', 'messages')).toEqual([MESSAGE])
    await unsent.releaseUnsent('friday', 'messages', [MESSAGE.clientMsgId])
    expect(records.folders.get('friday')?.has('outbox')).toBe(false)
  })

  it('is given to the app from the page’s storage, at the first start since the apps kept it', async () => {
    signedInToFriday()
    localStorage.setItem('crewbox:incident-outbox', JSON.stringify([ENTRY]))
    const { answer } = slowChatCache([MESSAGE])
    const { records } = app()
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const { copy } = await start()
    answer([MESSAGE])
    await copy.copyUnsent()
    expect(slot(records, 'friday', 'outbox')).toEqual([MESSAGE])
    expect(slot(records, 'friday', 'incident-outbox')).toEqual([ENTRY])
    // The page's storage lost nothing, so there is nothing to say.
    expect(info).not.toHaveBeenCalled()
  })

  it('gives the app nothing the box has had while the chat cache was being read', async () => {
    signedInToFriday()
    const acked = { ...MESSAGE, clientMsgId: 'acked' }
    const { answer } = slowChatCache([MESSAGE])
    const { records } = app()
    const { copy } = await start()
    // The box acknowledges it, and the page lets go of it, part way through.
    const unsent = await import('./unsent.ts')
    await unsent.releaseUnsent('friday', 'messages', [acked.clientMsgId])
    answer([acked, MESSAGE])
    await copy.copyUnsent()
    expect(slot(records, 'friday', 'outbox')).toEqual([MESSAGE])
    expect(unsent.holdsUnsent('friday', 'messages', acked.clientMsgId)).toBe(false)
  })

  it('gives it nothing of an event let go of meanwhile, as a phone handed on is', async () => {
    signedInToFriday()
    const { answer } = slowChatCache([])
    const { records } = app()
    const { copy } = await start()
    const unsent = await import('./unsent.ts')
    await unsent.releaseAllUnsent('friday')
    answer([MESSAGE])
    await copy.copyUnsent()
    expect(unsent.heldUnsent('friday', 'messages')).toEqual([])
    expect(records.folders.get('friday')?.has('outbox') ?? false).toBe(false)
  })

  it('says in the log how much the app kept that the page’s storage had lost', async () => {
    signedInToFriday()
    app({
      files: {
        friday: {
          outbox: JSON.stringify([MESSAGE]),
          'incident-outbox': JSON.stringify([ENTRY]),
        },
      },
    })
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    await start()
    await vi.waitFor(() =>
      expect(info).toHaveBeenCalledWith(expect.stringContaining('kept 2 unsent'))
    )
  })

  it('goes with an event forgotten on the Boxes screen, from the app’s files too', async () => {
    signedInToFriday()
    const { records } = app({ files: { saturday: { outbox: JSON.stringify([MESSAGE]) } } })
    const { scope } = await start()
    scope.rememberEvent(SATURDAY)
    const { forgetEvent } = await import('./boxes.ts')
    const unsent = await import('./unsent.ts')
    expect(unsent.heldUnsent('saturday', 'messages')).toEqual([MESSAGE])
    await forgetEvent('saturday')
    expect(unsent.heldUnsent('saturday', 'messages')).toEqual([])
    expect(records.folders.get('saturday')?.has('outbox') ?? false).toBe(false)
  })
})
