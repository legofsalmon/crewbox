/**
 * Delimited-text parsing shared by every module that imports paperwork.
 * Crew arrive with CSV exports and with blocks copied out of Excel or
 * Sheets (which land on the clipboard as TSV), so both go through here.
 */

/** RFC-4180 escaping: double embedded quotes, quote fields containing , " CR LF. */
export const escapeCsvField = (value: string): string => {
  const escaped = value.replace(/"/g, '""')
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
