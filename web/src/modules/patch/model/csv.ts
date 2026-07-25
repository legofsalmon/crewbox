import { PATCH_FIELDS, PATCH_FIELD_LABELS, patchKey, type SheetSnapshot } from './types'
import { patchSubBoxDisplay } from './sheetDoc'

/** RFC-4180 escaping: double embedded quotes, quote fields containing , " CR LF. */
export const escapeCsvField = (value: string): string => {
  const escaped = value.replace(/"/g, '""')
  return /[,"\n\r]/.test(escaped) ? `"${escaped}"` : escaped
}

/**
 * Parse delimiter-separated text (CSV files, or the TSV Google Sheets puts on
 * the clipboard) honouring RFC-4180-style quoting: quoted fields may contain
 * the delimiter, newlines, and doubled quotes. Handles CRLF and a UTF-8 BOM.
 */
export const parseDelimited = (text: string, delimiter: ',' | '\t'): string[][] => {
  const input = text.replace(/^\uFEFF/, '')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"' && field === '') {
      inQuotes = true
    } else if (ch === delimiter) {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += ch
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

export const parseCsv = (text: string): string[][] => parseDelimited(text, ',')
export const parseTsv = (text: string): string[][] => parseDelimited(text, '\t')

/**
 * Render a sheet as CSV. Two header rows: the artist names (each spanning
 * their five field columns) and the field labels; then one row per channel.
 * CRLF line endings and a UTF-8 BOM keep Excel happy.
 */
export const sheetToCsv = (sheet: SheetSnapshot): string => {
  const rows: string[][] = []

  const artistRow = ['']
  const fieldRow = ['Channel']
  for (const artist of sheet.artists) {
    artistRow.push(artist.name, '', '', '', '')
    for (const field of PATCH_FIELDS) fieldRow.push(PATCH_FIELD_LABELS[field])
  }
  rows.push(artistRow, fieldRow)

  for (const channel of sheet.channels) {
    const row = [channel.label]
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

  const body = rows.map((row) => row.map(escapeCsvField).join(',')).join('\r\n')
  return '\uFEFF' + body + '\r\n'
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
