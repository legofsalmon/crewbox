import { PATCH_FIELDS, PATCH_FIELD_LABELS, type PatchField } from './types'
import type { ImportedSheetData } from './sheetDoc'

export interface ImportResult {
  data: ImportedSheetData
  /** Headers from the source that had no matching Live Patch field. */
  skippedColumns: string[]
}

const FIELD_LABELS = PATCH_FIELDS.map((f) => PATCH_FIELD_LABELS[f])

const normalize = (header: string) => header.toLowerCase().replace(/[^a-z0-9#]/g, '')

/** Fuzzy-map a foreign column header onto a Live Patch field. */
const matchField = (header: string): PatchField | 'channel' | null => {
  const h = normalize(header)
  if (!h) return null
  if (/^(ch|chan|channel|chno|no|num|#)\d*$/.test(h) || h === 'channelname') return 'channel'
  if (h.includes('sub') || h.includes('box')) return 'subBox'
  if (h.includes('input') || h.includes('instrument') || h.includes('source')) return 'input'
  if (h.includes('desc') || h.includes('name')) return 'description'
  if (h.includes('mic') || h === 'di' || h.includes('micdi') || h.includes('transducer')) {
    return 'micDi'
  }
  if (h.includes('stand') || h.includes('clip')) return 'stand'
  return null
}

const isBlankRow = (row: string[]) => row.every((cell) => cell.trim() === '')

/** Detect a Live Patch CSV export: field labels repeating in groups of five. */
const isOwnExport = (rows: string[][]): boolean => {
  const header = rows[1]
  if (!header || header[0] !== 'Channel' || (header.length - 1) % FIELD_LABELS.length !== 0) {
    return false
  }
  for (let i = 1; i < header.length; i++) {
    if (header[i] !== FIELD_LABELS[(i - 1) % FIELD_LABELS.length]) return false
  }
  return true
}

const fromOwnExport = (rows: string[][]): ImportResult => {
  const artistCount = (rows[1].length - 1) / FIELD_LABELS.length
  const artists = Array.from({ length: artistCount }, (_, i) => ({
    name: rows[0]?.[1 + i * FIELD_LABELS.length]?.trim() || `Artist ${i + 1}`,
  }))
  const dataRows = rows.slice(2).filter((row) => !isBlankRow(row))
  const channels = dataRows.map((row, i) => ({ label: row[0]?.trim() || String(i + 1) }))
  const patches: ImportedSheetData['patches'] = artists.map((_, artistIndex) =>
    dataRows.map((row) => {
      const entry: Partial<Record<PatchField, string>> = {}
      PATCH_FIELDS.forEach((field, fieldIndex) => {
        const value = row[1 + artistIndex * FIELD_LABELS.length + fieldIndex]
        if (value?.trim()) entry[field] = value.trim()
      })
      return Object.keys(entry).length > 0 ? entry : undefined
    })
  )
  return { data: { channels, artists, patches }, skippedColumns: [] }
}

const fromGenericSheet = (rows: string[][]): ImportResult => {
  const header = rows[0] ?? []
  const mapping = header.map(matchField)
  const skippedColumns = header.filter((label, i) => label.trim() !== '' && mapping[i] === null)
  const channelCol = mapping.indexOf('channel')

  const dataRows = rows.slice(1).filter((row) => !isBlankRow(row))
  const channels = dataRows.map((row, i) => ({
    label: (channelCol >= 0 ? row[channelCol]?.trim() : '') || String(i + 1),
  }))
  const patches: ImportedSheetData['patches'] = [
    dataRows.map((row) => {
      const entry: Partial<Record<PatchField, string>> = {}
      mapping.forEach((field, col) => {
        if (field && field !== 'channel' && row[col]?.trim()) {
          // First matching column wins if headers map to the same field twice.
          if (!entry[field]) entry[field] = row[col].trim()
        }
      })
      return Object.keys(entry).length > 0 ? entry : undefined
    }),
  ]
  return { data: { channels, artists: [{ name: 'Artist 1' }], patches }, skippedColumns }
}

/**
 * Turn parsed CSV rows into an importable sheet. Recognises Live Patch's own
 * export format (multi-artist round trip); anything else is treated as a
 * generic single-artist patch sheet with fuzzy header matching.
 */
export const sheetFromCsv = (rows: string[][]): ImportResult => {
  const nonEmpty = rows.filter((row) => !isBlankRow(row))
  if (nonEmpty.length === 0)
    return { data: { channels: [], artists: [], patches: [] }, skippedColumns: [] }
  return isOwnExport(nonEmpty) ? fromOwnExport(nonEmpty) : fromGenericSheet(nonEmpty)
}
