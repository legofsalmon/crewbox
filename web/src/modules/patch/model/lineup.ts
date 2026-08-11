import { inRunningOrder } from '../../../shell/timetable/agenda.ts'
import { actsForStage, type Act } from '../../../shell/timetable/model.ts'
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
