import { saveText } from '../../../lib/download.ts'
import { csvFilename, sheetToCsv } from '../model/csv'
import type { SheetAct, SheetSnapshot } from '../model/types'

/** False when the shell cannot save files — the caller says so. */
export const downloadSheetCsv = (sheet: SheetSnapshot, acts: SheetAct[]): boolean =>
  saveText(csvFilename(sheet), 'text/csv;charset=utf-8;', sheetToCsv(sheet, acts))
