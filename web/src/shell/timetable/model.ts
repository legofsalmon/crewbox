import { newId } from '@crewbox/shared'
import * as Y from 'yjs'

/**
 * The event's timetable: who is on, where, and when.
 *
 * This is shell state rather than a module's, and that placement is the whole
 * point. The running order is the one document every department consults —
 * audio patches against it, lighting cues against it, a stage manager runs
 * the day off it, and an incident is timestamped against whatever was on at
 * the time. Owning it inside any one of those modules would mean a box that
 * turned that module off lost the timetable for everyone else.
 *
 * It began life inside the patch sheets, because that is where the festival
 * CSV first landed, which made the most-consulted document on site visible
 * only to the audio department. Consumers read from here now.
 *
 * One document per box. There is one event on at a time, and a festival's
 * several stages are a field on the act rather than several timetables.
 */

/** Times are plain "HH:MM" strings, parsed where they are used, never Date. */
export interface Act {
  id: string
  name: string
  /** Which stage, room or area. Free text — it is whatever the poster says. */
  stage: string
  /** Plain YYYY-MM-DD, so a multi-day festival is one timetable. */
  date: string
  /** "19:00". Empty when the slot is still TBC. */
  start: string
  end: string
  /**
   * Minutes between the previous act coming down and this one going on.
   * 0 when nothing says — including the first act of the day, which has no
   * act before it to change over from.
   */
  changeover: number
}

export interface TimetableSnapshot {
  acts: Act[]
}

export const LOCAL_ORIGIN = 'crewbox-timetable-local'

interface TimetableRoots {
  acts: Y.Array<Y.Map<unknown>>
}

export const getTimetableRoots = (doc: Y.Doc): TimetableRoots => ({
  acts: doc.getArray<Y.Map<unknown>>('acts'),
})

export const createTimetableUndoManager = (doc: Y.Doc): Y.UndoManager =>
  new Y.UndoManager([getTimetableRoots(doc).acts], { trackedOrigins: new Set([LOCAL_ORIGIN]) })

/** An act with every field present, whatever an older or partial doc holds. */
const withDefaults = (raw: Partial<Act>): Act => ({
  id: raw.id ?? newId(),
  name: raw.name ?? '',
  stage: raw.stage ?? '',
  date: raw.date ?? '',
  start: raw.start ?? '',
  end: raw.end ?? '',
  changeover: typeof raw.changeover === 'number' ? raw.changeover : 0,
})

export const snapshotTimetable = (doc: Y.Doc): TimetableSnapshot => ({
  // Defaults first, so a doc written before a field existed reads back with
  // an empty one rather than `undefined` reaching the UI.
  acts: getTimetableRoots(doc)
    .acts.toArray()
    .map((m) => withDefaults(m.toJSON() as Partial<Act>)),
})

const toYMap = (act: Act): Y.Map<unknown> => {
  const map = new Y.Map<unknown>()
  for (const [key, value] of Object.entries(act)) map.set(key, value)
  return map
}

/** Append an act. Returns its id so the caller can focus the new row. */
export const addAct = (doc: Y.Doc, fields: Partial<Omit<Act, 'id'>> = {}): string => {
  const act = withDefaults({ ...fields, id: newId() })
  doc.transact(() => getTimetableRoots(doc).acts.push([toYMap(act)]), LOCAL_ORIGIN)
  return act.id
}

/**
 * The act already on the running order that `fields` describes, if any.
 *
 * Same name, same stage, same day is the test — which is the one a person
 * applies holding two printouts side by side. A blank name matches nothing:
 * two unnamed slots on a stage are two slots, not one.
 */
const matchingAct = (
  acts: Y.Array<Y.Map<unknown>>,
  fields: Partial<Omit<Act, 'id'>>
): Y.Map<unknown> | null => {
  const name = (fields.name ?? '').trim().toLowerCase()
  if (!name) return null
  const stage = (fields.stage ?? '').trim().toLowerCase()
  const date = fields.date ?? ''
  return (
    acts.toArray().find(
      (map) =>
        String(map.get('name') ?? '')
          .trim()
          .toLowerCase() === name &&
        String(map.get('stage') ?? '')
          .trim()
          .toLowerCase() === stage &&
        (map.get('date') ?? '') === date
    ) ?? null
  )
}

/**
 * Add an act, or update the one that is already there.
 *
 * For importers. A festival's running order arrives as a file, and the same
 * file gets imported twice — a second sheet for the same stage, a re-import
 * after a correction, two people doing it at once. Appending blindly gives a
 * box a day listed twice, with half the patch hanging off each copy.
 *
 * Only the fields passed are written, so times somebody fixed by hand
 * survive a file that says nothing about them.
 */
export const upsertAct = (doc: Y.Doc, fields: Partial<Omit<Act, 'id'>>): string => {
  const { acts } = getTimetableRoots(doc)
  const existing = matchingAct(acts, fields)
  if (!existing) return addAct(doc, fields)
  const id = existing.get('id') as string
  doc.transact(() => {
    for (const [key, value] of Object.entries(fields)) existing.set(key, value)
  }, LOCAL_ORIGIN)
  return id
}

export const updateAct = (doc: Y.Doc, actId: string, fields: Partial<Omit<Act, 'id'>>): void => {
  const { acts } = getTimetableRoots(doc)
  doc.transact(() => {
    for (const map of acts.toArray()) {
      if (map.get('id') !== actId) continue
      for (const [key, value] of Object.entries(fields)) map.set(key, value)
      return
    }
  }, LOCAL_ORIGIN)
}

export const removeAct = (doc: Y.Doc, actId: string): void => {
  const { acts } = getTimetableRoots(doc)
  doc.transact(() => {
    const index = acts.toArray().findIndex((map) => map.get('id') === actId)
    if (index >= 0) acts.delete(index, 1)
  }, LOCAL_ORIGIN)
}

/**
 * Every stage named in the timetable, in first-appearance order.
 *
 * Consumers offer these rather than asking anyone to retype a stage name —
 * "Main Stage" and "Main stage" are two stages to a computer and one to a
 * crew, and the cheapest fix is never to type it twice.
 */
export const stagesIn = (acts: Act[]): string[] => [
  ...new Set(acts.map((a) => a.stage.trim()).filter(Boolean)),
]

/** The acts belonging to one stage on one date — a patch sheet's columns. */
export const actsForStage = (acts: Act[], stage: string, date: string): Act[] =>
  acts.filter((a) => a.stage.trim() === stage.trim() && (!date || a.date === date))
