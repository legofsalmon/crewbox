import { PATCH_FIELDS, PATCH_FIELD_LABELS, type PatchField } from './types'
import { festivalSheetFromCsv } from './importFestival'
import type { ImportedSheetData } from './sheetDoc'

export interface ImportResult {
  data: ImportedSheetData
  /** Headers from the source that had no matching Live Patch field. */
  skippedColumns: string[]
  /**
   * Things the file said that are worth telling whoever imported it —
   * a changeover that disagrees with the running order, so far. Never fatal;
   * the sheet still imports.
   */
  warnings?: string[]
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

/**
 * Detect crewbox's own export: field labels repeating in groups of five.
 *
 * Two widths are accepted. Current exports lead with Channel and Input;
 * exports from before the house input list existed lead with Channel alone,
 * and a crew with last season's CSV on a USB stick should not be told their
 * own file is foreign. Returns how many leading columns to skip, or null.
 */
const ownExportLead = (rows: string[][]): number | null => {
  const header = rows[1]
  if (!header || header[0] !== 'Channel') return null
  const lead = header[1] === 'Input' ? 2 : 1
  if ((header.length - lead) % FIELD_LABELS.length !== 0) return null
  for (let i = lead; i < header.length; i++) {
    if (header[i] !== FIELD_LABELS[(i - lead) % FIELD_LABELS.length]) return null
  }
  return lead
}

const fromOwnExport = (rows: string[][], lead: number): ImportResult => {
  const actCount = (rows[1].length - lead) / FIELD_LABELS.length
  const acts = Array.from({ length: actCount }, (_, i) => {
    const at = lead + i * FIELD_LABELS.length
    return {
      name: rows[0]?.[at]?.trim() || `Act ${i + 1}`,
      // Written into the spare cell beside the name; blank on older exports.
      spec: rows[0]?.[at + 1]?.trim() ?? '',
    }
  })
  const dataRows = rows.slice(2).filter((row) => !isBlankRow(row))
  const channels = dataRows.map((row, i) => ({
    label: row[0]?.trim() || String(i + 1),
    input: lead === 2 ? (row[1]?.trim() ?? '') : '',
  }))
  const patches: ImportedSheetData['patches'] = acts.map((_, actIndex) =>
    dataRows.map((row) => {
      const entry: Partial<Record<PatchField, string>> = {}
      PATCH_FIELDS.forEach((field, fieldIndex) => {
        const value = row[lead + actIndex * FIELD_LABELS.length + fieldIndex]
        if (value?.trim()) entry[field] = value.trim()
      })
      return Object.keys(entry).length > 0 ? entry : undefined
    })
  )
  return { data: { channels, acts, patches }, skippedColumns: [] }
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
  return { data: { channels, acts: [{ name: 'Act 1' }], patches }, skippedColumns }
}

/**
 * Turn parsed CSV rows into an importable sheet.
 *
 * Three shapes, in order of how confidently they can be recognised: crewbox's
 * own export (a round trip), the festival master-patch layout crews keep in
 * Google Sheets (see importFestival.ts), and failing both, a generic
 * single-act sheet with fuzzy header matching.
 *
 * The festival parser is given the rows *before* blanks are stripped, because
 * its layout is positional — the act names sit a fixed distance above the
 * header — and dropping a spacer row would move them.
 */
export const sheetFromCsv = (rows: string[][]): ImportResult => {
  const nonEmpty = rows.filter((row) => !isBlankRow(row))
  if (nonEmpty.length === 0)
    return { data: { channels: [], acts: [], patches: [] }, skippedColumns: [] }
  const lead = ownExportLead(nonEmpty)
  if (lead !== null) return fromOwnExport(nonEmpty, lead)
  const festival = festivalSheetFromCsv(rows)
  if (festival.matched) {
    return { data: festival.data, skippedColumns: [], warnings: festival.warnings }
  }
  return fromGenericSheet(nonEmpty)
}
