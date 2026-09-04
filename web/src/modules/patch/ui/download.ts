import { deliverText, type Delivered } from '../../../lib/download.ts'
import { csvFilename, sheetToCsv } from '../model/csv'
import type { SheetAct, SheetSnapshot } from '../model/types'

/** Downloaded, handed to the share sheet, or neither — the caller says so. */
export const downloadSheetCsv = (sheet: SheetSnapshot, acts: SheetAct[]): Promise<Delivered> =>
  deliverText(csvFilename(sheet), 'text/csv;charset=utf-8;', sheetToCsv(sheet, acts))
