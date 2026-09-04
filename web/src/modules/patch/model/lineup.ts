import type * as Y from 'yjs'
import { inRunningOrder } from '@crewbox/shared'
import { actsForStage, updateAct, type Act } from '../../../shell/timetable/model.ts'
import { emptyExtras, type SheetAct, type SheetMeta, type SheetSnapshot } from './types'

/**
 * Which acts a patch sheet is about.
 *
 * A patch sheet is a stage on a day, so its columns are that stage's slots in
 * the event's running order. Nothing about who is on or when is stored here
 * any more: a set time corrected once, anywhere, moves this sheet, the
 * countdowns and every other module at the same moment.
 *
 * The sheet keeps only its own half — the spec, the notes, the riders — and
 * that half is merged back on below.
 */

/**
 * The acts a sheet covers, before its own detail is merged in.
 *
 * A sheet with no stage named yet covers everything on its date rather than
 * nothing. A blank grid is the worse answer for someone who has just made a
 * sheet and not got as far as saying which stage it is, and the fix — name
 * the stage — is one field away in the lineup.
 */
export const actsOnSheet = (meta: Pick<SheetMeta, 'stage' | 'date'>, acts: Act[]): Act[] =>
  meta.stage.trim()
    ? actsForStage(acts, meta.stage, meta.date)
    : acts.filter((act) => !meta.date || act.date === meta.date)

/**
 * This sheet's acts, in running order, with its own detail merged in.
 *
 * Every consumer — the grid, the lineup, the stage patch, the CSV export —
 * goes through here, so they cannot disagree about which acts the sheet has
 * or what order they are in.
 */
export const sheetActs = (snapshot: SheetSnapshot, acts: Act[]): SheetAct[] =>
  inRunningOrder(actsOnSheet(snapshot.meta, acts)).map((act) => {
    const { spec, notes, files } = snapshot.extras[act.id] ?? emptyExtras(act.id)
    return { ...act, spec, notes, files }
  })

/**
 * Rename the stage this sheet is for, taking its acts with it.
 *
 * The stage field decides the columns now, so on its own a rename would empty
 * the sheet — every act still filed under the old spelling, the grid blank,
 * and nothing saying why. Someone typing "Main" over an imported sheet's
 * machine-generated stage name means "this sheet is the Main stage", not
 * "throw this away", so the acts follow the name.
 *
 * `acts` is what the sheet is currently showing, which is exactly the set
 * that should move. The one case that must not move anything is a sheet with
 * no stage named yet: it is showing the whole day, and dragging every other
 * stage's acts onto this name would be a rename of the entire event.
 */
export const setSheetStage = (
  timetableDoc: Y.Doc,
  meta: Pick<SheetMeta, 'stage'>,
  acts: SheetAct[],
  next: string
): void => {
  const from = meta.stage.trim()
  const to = next.trim()
  if (from === to || !from) return
  for (const act of acts) updateAct(timetableDoc, act.id, { stage: to })
}

/**
 * Move this sheet to another day, taking its acts with it.
 *
 * Exactly the same argument as `setSheetStage`, for the other half of what
 * picks the columns — and it was missing. The date field decides which day's
 * acts appear, so changing it on its own left every act filed under the old
 * date and the grid blank, with nothing saying why. Somebody correcting a
 * sheet dated the load-in day to the day it is actually about means "this
 * sheet is the Saturday", not "throw this away".
 *
 * The same one exception too: a sheet with no date yet is showing every day,
 * and dragging the whole festival onto one date would be a change to the
 * event rather than to this sheet.
 */
export const setSheetDate = (
  timetableDoc: Y.Doc,
  meta: Pick<SheetMeta, 'date'>,
  acts: SheetAct[],
  next: string
): void => {
  const from = meta.date.trim()
  const to = next.trim()
  if (from === to || !from) return
  for (const act of acts) updateAct(timetableDoc, act.id, { date: to })
}
