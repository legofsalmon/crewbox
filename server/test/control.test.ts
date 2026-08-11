import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { Act } from '@crewbox/shared'
import {
  controlKey,
  keyFromHeaders,
  keyMatches,
  readRunningOrder,
  stageBoard,
  Tally,
} from '../src/control.ts'

/**
 * The keyed control surface, and the tally it exists to raise.
 *
 * The tests worth having here are about the ways this could quietly do the
 * wrong thing: letting a caller in who should not be, leaving a red ON AIR
 * bar on somebody who is no longer there to clear it, and telling a desk the
 * headliner is on at nine in the morning.
 */

const store = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial))
  return {
    getSetting: (key: string) => data.get(key),
    setSetting: (key: string, value: string) => void data.set(key, value),
    all: () => data,
  }
}

describe('presenting the key', () => {
  it('takes it from x-api-key', () => {
    expect(keyFromHeaders({ 'x-api-key': 'abc123' })).toBe('abc123')
  })

  it('takes it from an Authorization bearer, which is what most tools send', () => {
    expect(keyFromHeaders({ authorization: 'Bearer abc123' })).toBe('abc123')
    expect(keyFromHeaders({ authorization: 'bearer abc123' })).toBe('abc123')
  })

  it('has nothing to say about a request that presented nothing', () => {
    expect(keyFromHeaders({})).toBeNull()
    expect(keyFromHeaders({ authorization: 'Basic abc123' })).toBeNull()
    expect(keyFromHeaders({ 'x-api-key': '   ' })).toBeNull()
  })
})

describe('checking the key', () => {
  it('accepts the real one and refuses everything else', () => {
    expect(keyMatches('secret', 'secret')).toBe(true)
    expect(keyMatches('secrez', 'secret')).toBe(false)
  })

  it('refuses a prefix, which a naive compare would let through', () => {
    expect(keyMatches('sec', 'secret')).toBe(false)
    expect(keyMatches('secretsecret', 'secret')).toBe(false)
  })

  it('refuses when there is nothing to check', () => {
    expect(keyMatches(null, 'secret')).toBe(false)
    expect(keyMatches('secret', '')).toBe(false)
  })
})

describe('where the key comes from', () => {
  it('mints one on first use and remembers it', () => {
    const s = store()
    const first = controlKey(s, {})
    expect(first).toHaveLength(32)
    expect(controlKey(s, {})).toBe(first)
  })

  it('lets the environment override a stored one', () => {
    // The recovery path, and the same rule the rest of the box follows: a
    // key that has leaked, or a spare box that must answer to the desk's
    // existing button, is fixed at startup rather than by reconfiguring.
    const s = store()
    controlKey(s, {})
    expect(controlKey(s, { CREWBOX_CONTROL_KEY: 'from-env' })).toBe('from-env')
  })

  it('does not persist the environment key over the stored one', () => {
    // Unsetting the variable must put the box back where it was, not leave
    // it answering to a key somebody exported once in a terminal.
    const s = store()
    const minted = controlKey(s, {})
    controlKey(s, { CREWBOX_CONTROL_KEY: 'from-env' })
    expect(controlKey(s, {})).toBe(minted)
  })
})

describe('who is on air', () => {
  it('starts with nobody', () => {
    expect(new Tally().current().userId).toBeNull()
  })

  it('reports a change worth telling everyone about', () => {
    const tally = new Tally()
    expect(tally.set('u1')).toBe(true)
    expect(tally.current().userId).toBe('u1')
  })

  it('says nothing when the same camera is cut to twice', () => {
    // A desk holding a button, or a mixer re-sending its state every second,
    // must not turn into a broadcast per second to every phone on site.
    const tally = new Tally()
    tally.set('u1')
    expect(tally.set('u1')).toBe(false)
  })

  it('clears with null, so one button can be bound to "off air"', () => {
    const tally = new Tally()
    tally.set('u1')
    expect(tally.set(null)).toBe(true)
    expect(tally.current().userId).toBeNull()
  })

  it('treats blank as clear rather than as a person called ""', () => {
    const tally = new Tally()
    tally.set('u1')
    expect(tally.set('   ')).toBe(true)
    expect(tally.current().userId).toBeNull()
  })

  it('stamps when it went live, and unstamps when it goes off', () => {
    let clock = 1000
    const tally = new Tally(() => clock)
    tally.set('u1')
    expect(tally.current().since).toBe(1000)
    clock = 2000
    tally.set(null)
    expect(tally.current().since).toBe(0)
  })

  it('lets go of somebody who has left', () => {
    // Otherwise the red bar belongs to a person who is not there to clear it,
    // and nobody else can either.
    const tally = new Tally()
    tally.set('u1')
    expect(tally.forget('u1')).toBe(true)
    expect(tally.current().userId).toBeNull()
  })

  it('ignores a departure that was never on air', () => {
    const tally = new Tally()
    tally.set('u1')
    expect(tally.forget('u2')).toBe(false)
    expect(tally.current().userId).toBe('u1')
  })
})

/** A timetable document as a phone would have left it on the relay. */
const timetableDoc = (acts: Partial<Act>[]): Y.Doc => {
  const doc = new Y.Doc()
  const array = doc.getArray<Y.Map<unknown>>('acts')
  for (const act of acts) {
    const map = new Y.Map<unknown>()
    for (const [key, value] of Object.entries(act)) map.set(key, value)
    array.push([map])
  }
  return doc
}

describe('reading the running order off the relay', () => {
  it('has nothing to say when the box is holding no timetable', () => {
    // Which is the normal state of a box nobody has the app open on — not an
    // error, and not an empty running order either.
    expect(readRunningOrder(null)).toEqual([])
  })

  it('reads what a phone wrote', () => {
    const acts = readRunningOrder(
      timetableDoc([
        { id: 'a1', name: 'Night Bus', stage: 'Main Stage', start: '23:30', end: '00:45' },
      ])
    )
    expect(acts).toEqual([
      {
        id: 'a1',
        name: 'Night Bus',
        stage: 'Main Stage',
        date: '',
        start: '23:30',
        end: '00:45',
        changeover: 0,
      },
    ])
  })

  it('reads a doc written by a version that knew different fields', () => {
    // The app on a given phone can be newer or older than the box. A field
    // that is missing, or arrives as something other than a string, has to
    // read as empty rather than throwing on a route a desk polls all night.
    const [act] = readRunningOrder(
      timetableDoc([{ name: 42 as unknown as string, stage: 'Main Stage', changeover: 'HR' }])
    )
    expect(act).toMatchObject({ name: '', start: '', end: '', changeover: 0 })
  })

  it('keeps a half-typed act rather than hiding it', () => {
    // The phones' countdown carries unnamed slots, so the box has to as well.
    // A stage the box calls clear and the sidebar calls busy is worse than a
    // button with a blank on it.
    expect(readRunningOrder(timetableDoc([{ stage: 'Main Stage', start: '21:00' }]))).toHaveLength(
      1
    )
  })
})

const at = (hours: number, minutes: number): Date => new Date(2026, 7, 11, hours, minutes)

let seq = 0
const act = (fields: Partial<Act>): Act => ({
  id: `act-${++seq}`,
  name: '',
  stage: '',
  date: '',
  start: '',
  end: '',
  changeover: 0,
  ...fields,
})

const DAY = [
  act({ name: 'Sound Check Kids', stage: 'Main Stage', start: '19:00', end: '20:00' }),
  act({ name: 'The Fixture', stage: 'Main Stage', start: '21:00', end: '22:30' }),
  act({ name: 'Night Bus', stage: 'Main Stage', start: '23:30', end: '00:45' }),
  act({ name: 'Backline', stage: 'Second Stage', start: '22:00', end: '23:00' }),
]

describe('what a desk button shows', () => {
  it('names what is on and what is next', () => {
    const [main] = stageBoard(DAY, at(21, 30))
    expect(main?.onNow?.name).toBe('The Fixture')
    expect(main?.next?.name).toBe('Night Bus')
  })

  it('gives the numbers and the words for them', () => {
    // The words are the point: a Stream Deck button prints a string, and
    // every desk doing its own minute arithmetic is a desk doing it wrong.
    const [main] = stageBoard(DAY, at(21, 30))
    expect(main?.onNow?.endsIn).toBe(60)
    expect(main?.onNow?.ends).toBe('in 1h')
    expect(main?.next?.starts).toBe('in 2h')
  })

  it('puts the stage with something on it first', () => {
    const board = stageBoard(DAY, at(21, 30))
    expect(board.map((s) => s.stage)).toEqual(['Main Stage', 'Second Stage'])
  })

  it('knows the 00:45 set belongs to tonight, not to tomorrow morning', () => {
    // The failure this guards is the whole reason the maths is shared with
    // the app: sorted by the clock alone, the headliner is the first thing
    // on in the morning and the desk says so an hour before doors.
    const [main] = stageBoard(DAY, at(23, 50))
    expect(main?.onNow?.name).toBe('Night Bus')
    expect(main?.next).toBeNull()
  })

  it('still says so after midnight', () => {
    const [main] = stageBoard(DAY, new Date(2026, 7, 12, 0, 30))
    expect(main?.onNow?.name).toBe('Night Bus')
    expect(main?.onNow?.ends).toBe('in 15 min')
  })

  it('leaves next empty once a stage is done for the day', () => {
    const second = stageBoard(DAY, at(23, 50)).find((s) => s.stage === 'Second Stage')
    expect(second?.onNow).toBeNull()
    expect(second?.next).toBeNull()
  })

  it('never calls a TBC slot the act that is on', () => {
    const board = stageBoard([act({ name: 'Special Guest', stage: 'Main Stage' })], at(21, 30))
    expect(board[0]?.onNow).toBeNull()
    expect(board[0]?.next).toBeNull()
  })

  it('files an act with no stage under a name a button can print', () => {
    const board = stageBoard([act({ name: 'Walkabout', start: '21:00', end: '22:00' })], at(21, 30))
    expect(board[0]?.stage).toBe('Stage')
    expect(board[0]?.onNow?.name).toBe('Walkabout')
  })
})
