import { PATCH_FIELDS, PATCH_FIELD_LABELS, patchKey, type SheetSnapshot } from './types'
import { patchSubBoxDisplay } from './sheetDoc'
import { toCsv } from '../../_shared/csv'

export { escapeCsvField, parseCsv, parseDelimited, parseTsv } from '../../_shared/csv'

/**
 * Render a sheet as CSV. Two header rows: the artist names (each spanning
 * their five field columns) and the field labels; then one row per channel.
 * CRLF line endings and a UTF-8 BOM keep Excel happy.
 *
 * The first two columns are the channel and its house input — the spine the
 * whole sheet hangs off, and the pair a festival sheet puts down its left
 * edge. Each artist's spec rides in the spare cell beside their name in the
 * top row, where the field parser never looks, so a round trip keeps it.
 */
export const sheetToCsv = (sheet: SheetSnapshot): string => {
  const rows: string[][] = []

  const artistRow = ['', '']
  const fieldRow = ['Channel', 'Input']
  for (const artist of sheet.artists) {
    artistRow.push(artist.name, artist.spec, '', '', '')
    for (const field of PATCH_FIELDS) fieldRow.push(PATCH_FIELD_LABELS[field])
  }
  rows.push(artistRow, fieldRow)

  for (const channel of sheet.channels) {
    const row = [channel.label, channel.input]
    for (const artist of sheet.artists) {
      const entry = sheet.patches[patchKey(artist.id, channel.id)]
      if (!entry) {
        row.push('', '', '', '', '')
        continue
      }
      for (const field of PATCH_FIELDS) {
        row.push(
          field === 'subBox' ? patchSubBoxDisplay(entry, sheet.subBoxes) : (entry[field] ?? '')
        )
      }
    }
    rows.push(row)
  }

  return toCsv(rows)
}

/** Filename like `My_Show_Main_Stage_2026-07-23.csv`. */
export const csvFilename = (sheet: SheetSnapshot): string => {
  const clean = (s: string, fallback: string) =>
    (s.trim() || fallback).replace(/[^a-zA-Z0-9-]+/g, '_')
  const title = clean(sheet.meta.title, 'sheet')
  const stage = clean(sheet.meta.stage, 'stage')
  const date = sheet.meta.date || 'undated'
  return `${title}_${stage}_${date}.csv`
}
