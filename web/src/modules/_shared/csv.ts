/**
 * Delimited-text parsing shared by every module that imports paperwork.
 * Crew arrive with CSV exports and with blocks copied out of Excel or
 * Sheets (which land on the clipboard as TSV), so both go through here.
 */

/**
 * Characters a spreadsheet reads as the start of a formula.
 *
 * `=` and `@` are the obvious two; `+` and `-` are the ones people forget,
 * and a leading tab or carriage return is how the check is walked past —
 * Excel strips them before deciding.
 */
const FORMULA_START = /^[=+\-@\t\r]/

/**
 * A plain number, which is never a formula and is often a column.
 *
 * Without this exception a weight of `-2.5` or a trim height below stage
 * comes out of the export as text, and the spreadsheet the crew were going
 * to sum stops summing. `-2+3+cmd|' /C calc'!A0` is not a plain number and
 * is still guarded.
 */
const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?$/

/**
 * RFC-4180 escaping: double embedded quotes, quote fields containing , " CR LF.
 *
 * Plus one thing RFC-4180 has no opinion about. A patch sheet is paperwork
 * that gets exported and mailed on, and the person who opens it opens it in
 * Excel or Sheets — where a cell beginning `=`, `+`, `-` or `@` is not text,
 * it is a formula, and `=HYPERLINK(...)` or a `=cmd|...` DDE payload runs on
 * their machine. Every string in the export came from a crew member typing
 * into a shared document that anyone at the event can edit, so this is not a
 * hypothetical route in.
 *
 * A leading apostrophe is the spreadsheet convention for "this is text": it
 * is consumed on import and does not appear in the cell. Anything read back
 * by a program rather than a person goes through `parseCsv`, which is not a
 * spreadsheet and does not strip it — so the round trip is not lossless, and
 * that is the trade. Nothing in this repo round-trips its own CSV; the
 * importers read other people's paperwork.
 */
export const escapeCsvField = (value: string): string => {
  const risky = FORMULA_START.test(value) && !PLAIN_NUMBER.test(value)
  const guarded = risky ? `'${value}` : value
  const escaped = guarded.replace(/"/g, '""')
  return /[,"\n\r]/.test(escaped) ? `"${escaped}"` : escaped
}

/**
 * Parse delimiter-separated text honouring RFC-4180-style quoting: quoted
 * fields may contain the delimiter, newlines, and doubled quotes. Handles
 * CRLF and a UTF-8 BOM.
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

export const isBlankRow = (row: string[]) => row.every((cell) => cell.trim() === '')

/** Header text reduced for fuzzy matching: lowercase, alphanumerics and # only. */
export const normalizeHeader = (header: string) => header.toLowerCase().replace(/[^a-z0-9#]/g, '')

/** Render rows as CSV with CRLF endings and a UTF-8 BOM, which keeps Excel happy. */
export const toCsv = (rows: string[][]): string =>
  '\uFEFF' + rows.map((row) => row.map(escapeCsvField).join(',')).join('\r\n') + '\r\n'
