// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicConfig } from '@crewbox/shared'
// Loaded for what they register: the Boxes screen counts every store the app has.
import '../modules/patch/store/docManager.ts'
import '../modules/lighting/store/docManager.ts'
import '../modules/video/store/screensStore.ts'
import { findBox, forgetCopy, holdingsOf, lastHere } from './boxes.ts'

/**
 * The Boxes screen's reading of the device, and of a typed address.
 *
 * What it deletes is exercised against a real browser's IndexedDB, in
 * e2e/boxes.spec.ts; there is none here.
 */

const config = (fields: Partial<PublicConfig>): PublicConfig => ({
  eventName: '',
  wifiSsid: '',
  voiceEnabled: false,
  modules: [],
  ...fields,
})

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('crewbox:db-epoch', 'friday')
})

afterEach(() => {
  delete (window as { Capacitor?: unknown }).Capacitor
  localStorage.clear()
})

describe('an address typed into the Boxes screen', () => {
  it('is asked which event it is running, before anything goes to it', async () => {
    const asked: string[] = []
    const found = await findBox(' 192.168.8.1 ', async (origin) => {
      asked.push(origin)
      return config({ eventId: 'saturday', eventName: 'Harbour Fest' })
    })
    expect(asked).toEqual(['http://192.168.8.1'])
    expect(found).toEqual({
      kind: 'event',
      origin: 'http://192.168.8.1',
      id: 'saturday',
      name: 'Harbour Fest',
    })
  })

  it('says nothing answered, when nothing did', async () => {
    const found = await findBox('10.0.0.9', () => Promise.reject(new TypeError('Failed to fetch')))
    expect(found).toEqual({ kind: 'unreachable', origin: 'http://10.0.0.9' })
  })

  it('tells a box too old to say its event from one that says', async () => {
    // Filing it under a guessed event is what this whole change prevents.
    expect(await findBox('10.0.0.9', async () => config({}))).toMatchObject({ kind: 'too-old' })
    expect(await findBox('10.0.0.9', async () => config({ eventId: 'no-good' }))).toMatchObject({
      kind: 'too-old',
    })
  })

  it('asks for an address when given none', async () => {
    const fetchConfig = vi.fn()
    expect(await findBox('   ', fetchConfig)).toMatchObject({ kind: 'invalid' })
    expect(fetchConfig).not.toHaveBeenCalled()
  })

  it('says why an iPhone will not use a name over plain HTTP, without trying', async () => {
    ;(window as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
    }
    const fetchConfig = vi.fn()
    const found = await findBox('chat.crew.example', fetchConfig)
    expect(found).toMatchObject({ kind: 'invalid' })
    expect(found.kind === 'invalid' && found.message).toMatch(/HTTPS/)
    expect(fetchConfig).not.toHaveBeenCalled()
  })
})

describe('what a device holds for an event', () => {
  it('counts its documents and the show-log entries it never sent', async () => {
    localStorage.setItem('crewbox@sat:patch-sheets', JSON.stringify(['a', 'b']))
    localStorage.setItem('crewbox@sat:lighting-docs', JSON.stringify(['c']))
    localStorage.setItem(
      'crewbox@sat:incident-outbox',
      JSON.stringify([
        {
          clientMsgId: 'q1',
          kind: 'note',
          severity: 'note',
          body: 'Barrier moved',
          at: 1,
          stage: 'Main',
          actId: '',
          actName: '',
        },
      ])
    )
    // The first event's, under today's names, are not the second's.
    localStorage.setItem('crewbox:patch-sheets', JSON.stringify(['x', 'y', 'z']))
    expect(await holdingsOf('sat')).toEqual({ documents: 3, unsentMessages: 0, unsentEntries: 1 })
    expect(await holdingsOf('friday')).toMatchObject({ documents: 3, unsentEntries: 0 })
  })
})

describe('what forgetting an event is said to delete', () => {
  it('says what the box has a copy of', () => {
    const { gone, lost } = forgetCopy({ documents: 3, unsentMessages: 0, unsentEntries: 0 })
    expect(gone).toBe(
      'This device deletes what it keeps for it: 3 documents, its running order, its chat and ' +
        'your sign-in. The box has its own copy of those, for as long as it runs this event.'
    )
    expect(lost).toBeNull()
  })

  it('says apart what exists nowhere else', () => {
    expect(forgetCopy({ documents: 1, unsentMessages: 2, unsentEntries: 1 })).toEqual({
      gone: expect.stringContaining('1 document, its running order') as unknown as string,
      lost: 'It also deletes 2 messages and 1 show-log entry that never reached the box, and nothing else has a copy.',
    })
    expect(forgetCopy({ documents: 0, unsentMessages: 1, unsentEntries: 0 }).lost).toBe(
      'It also deletes 1 message that never reached the box, and nothing else has a copy.'
    )
  })
})

describe('when a box last let this device in', () => {
  const now = new Date(2026, 8, 24, 18, 30).getTime()

  it('is nothing for a box that never has', () => {
    expect(lastHere(0, now)).toBe('')
  })

  it('is a time today, a weekday this week, and a date before that', () => {
    expect(lastHere(new Date(2026, 8, 24, 9, 5).getTime(), now)).toMatch(/^Last here today, /)
    expect(lastHere(new Date(2026, 8, 21, 14, 2).getTime(), now)).toMatch(/^Last here \S+ \d/)
    const old = lastHere(new Date(2026, 7, 2, 14, 2).getTime(), now)
    expect(old).toMatch(/^Last here /)
    expect(old).not.toMatch(/:/)
  })
})
