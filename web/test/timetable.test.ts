import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  actsForStage,
  addAct,
  removeAct,
  snapshotTimetable,
  stagesIn,
  updateAct,
  upsertAct,
  type Act,
} from '../src/shell/timetable/model.ts'

/**
 * The event's timetable, which lives in the shell rather than in a module.
 *
 * These drive the real Y.Doc rather than a stand-in, because the point of
 * moving the running order out of the patch sheets was that several modules
 * read and write the same document at once — and CRDT behaviour is exactly
 * what a plain-object fake would not reproduce.
 */

const doc = () => new Y.Doc()

describe('keeping the running order', () => {
  it('adds an act and reads it back whole', () => {
    const d = doc()
    const id = addAct(d, { name: 'The Harbour Lights', stage: 'Main', start: '21:00' })
    const [act] = snapshotTimetable(d).acts
    expect(act?.id).toBe(id)
    expect(act?.name).toBe('The Harbour Lights')
    // Fields nobody filled read as empty, never undefined — the UI binds
    // straight to these and an undefined turns a controlled input loose.
    expect(act?.end).toBe('')
    expect(act?.date).toBe('')
    expect(act?.changeover).toBe(0)
  })

  it('edits one act without touching its neighbours', () => {
    const d = doc()
    const first = addAct(d, { name: 'Opener', start: '19:00' })
    const second = addAct(d, { name: 'Headliner', start: '22:00' })

    updateAct(d, second, { start: '22:30' })

    const acts = snapshotTimetable(d).acts
    expect(acts.find((a) => a.id === second)?.start).toBe('22:30')
    expect(acts.find((a) => a.id === first)?.start).toBe('19:00')
  })

  it('ignores an edit to an act that has gone', () => {
    // Two people can be looking at the running order while one deletes a
    // slot. The other's next keystroke must not resurrect it.
    const d = doc()
    const id = addAct(d, { name: 'Cancelled' })
    removeAct(d, id)
    updateAct(d, id, { name: 'Back from the dead' })
    expect(snapshotTimetable(d).acts).toHaveLength(0)
  })

  it('keeps the order acts were added in', () => {
    // The document order is the order of entry; sorting for display is the
    // reader's job, and a store that reordered underneath an editor would
    // move a row out from under a finger.
    const d = doc()
    addAct(d, { name: 'One' })
    addAct(d, { name: 'Two' })
    addAct(d, { name: 'Three' })
    expect(snapshotTimetable(d).acts.map((a) => a.name)).toEqual(['One', 'Two', 'Three'])
  })
})

describe('importing a running order that is already here', () => {
  /**
   * A festival's running order arrives as a file, and the same file gets
   * imported more than once — a second patch sheet for the same stage, a
   * re-import after a correction, two people doing it at the same moment.
   * Appending blindly gives a box the day listed twice, with half the patch
   * hanging off each copy and no sign which is which.
   */
  const opener = { name: 'The Harbour Lights', stage: 'Main', date: '2026-08-09' }

  it('reconciles with the act already there instead of listing it twice', () => {
    const d = doc()
    const first = upsertAct(d, { ...opener, start: '19:00' })
    const second = upsertAct(d, { ...opener, start: '19:00' })
    expect(second).toBe(first)
    expect(snapshotTimetable(d).acts).toHaveLength(1)
  })

  it('takes the file’s corrections', () => {
    const d = doc()
    const id = upsertAct(d, { ...opener, start: '19:00' })
    upsertAct(d, { ...opener, start: '19:30' })
    expect(snapshotTimetable(d).acts[0]).toMatchObject({ id, start: '19:30' })
  })

  it('leaves alone what the file says nothing about', () => {
    // Blank cells are not corrections. Someone fixed the end time on their
    // phone; re-importing the file must not wipe it back out.
    const d = doc()
    const id = upsertAct(d, opener)
    updateAct(d, id, { end: '19:45' })
    upsertAct(d, { ...opener, start: '19:00' })
    expect(snapshotTimetable(d).acts[0]).toMatchObject({ start: '19:00', end: '19:45' })
  })

  it('keeps the spelling the stage already had', () => {
    /**
     * The match is case-insensitive — "MAIN STAGE" and "Main Stage" are one
     * stage to a crew — but writing the file's spelling back renamed the
     * stage for everybody. A patch sheet finds its columns by comparing its
     * own `meta.stage` to the act's *exactly*, so an import typed in
     * capitals silently emptied the grid of every sheet already pointing at
     * that stage. Nothing said why: the acts were still there, under a name
     * the sheet no longer recognised.
     */
    const d = doc()
    upsertAct(d, { ...opener, start: '19:00' })
    upsertAct(d, { name: 'THE HARBOUR LIGHTS', stage: 'MAIN', date: opener.date, end: '19:45' })

    const [act] = snapshotTimetable(d).acts
    expect(snapshotTimetable(d).acts).toHaveLength(1)
    expect(act).toMatchObject({ name: 'The Harbour Lights', stage: 'Main' })
    // And the fields the file did add are still taken.
    expect(act).toMatchObject({ start: '19:00', end: '19:45' })
  })

  it('keeps the same name on two stages apart', () => {
    // An act genuinely can play twice — a second stage, or the next day.
    const d = doc()
    upsertAct(d, opener)
    upsertAct(d, { ...opener, stage: 'Barn' })
    upsertAct(d, { ...opener, date: '2026-08-10' })
    expect(snapshotTimetable(d).acts).toHaveLength(3)
  })

  it('never merges two unnamed slots', () => {
    // Two blanks on a stage are two slots someone is about to fill in, not
    // one slot written down twice.
    const d = doc()
    upsertAct(d, { stage: 'Main', date: '2026-08-09' })
    upsertAct(d, { stage: 'Main', date: '2026-08-09' })
    expect(snapshotTimetable(d).acts).toHaveLength(2)
  })
})

describe('two devices editing at once', () => {
  it('merges independent additions rather than losing one', () => {
    // The case that made this a shared document: a stage manager adds a slot
    // on their phone while the production desk adds another. Last-write-wins
    // storage would drop one of them silently.
    const a = doc()
    const b = doc()
    addAct(a, { name: 'From the desk', stage: 'Main' })
    addAct(b, { name: 'From the phone', stage: 'Barn' })

    Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))

    for (const d of [a, b]) {
      expect(
        snapshotTimetable(d)
          .acts.map((x) => x.name)
          .sort()
      ).toEqual(['From the desk', 'From the phone'])
    }
  })

  it('lets a later correction to the same act win on both devices', () => {
    const a = doc()
    const id = addAct(a, { name: 'Headliner', start: '22:00' })
    const b = doc()
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))

    updateAct(b, id, { start: '22:30' })
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b))

    expect(snapshotTimetable(a).acts[0]?.start).toBe('22:30')
  })
})

describe('what consumers ask the timetable', () => {
  const acts: Act[] = [
    { id: '1', name: 'A', stage: 'Main', date: '2026-08-09', start: '', end: '', changeover: 0 },
    { id: '2', name: 'B', stage: 'Barn', date: '2026-08-09', start: '', end: '', changeover: 0 },
    { id: '3', name: 'C', stage: 'Main', date: '2026-08-10', start: '', end: '', changeover: 0 },
    {
      id: '4',
      name: 'D',
      stage: '  Main  ',
      date: '2026-08-09',
      start: '',
      end: '',
      changeover: 0,
    },
  ]

  it('lists the stages once each, in the order they appear', () => {
    // Offered back to whoever types the next one: "Main Stage" and "Main
    // stage" are two stages to a computer and one to a crew.
    expect(stagesIn(acts)).toEqual(['Main', 'Barn'])
  })

  it('gives a patch sheet exactly its own columns', () => {
    // One stage, one day. This is what replaces a sheet owning its acts.
    expect(actsForStage(acts, 'Main', '2026-08-09').map((a) => a.name)).toEqual(['A', 'D'])
  })

  it('matches a stage typed with stray spaces', () => {
    expect(actsForStage(acts, ' Main ', '2026-08-09')).toHaveLength(2)
  })

  it('takes every day when no date is asked for', () => {
    expect(actsForStage(acts, 'Main', '').map((a) => a.name)).toEqual(['A', 'C', 'D'])
  })
})
