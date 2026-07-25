/** The five patch fields every artist has per channel. */
export const PATCH_FIELDS = ['subBox', 'input', 'description', 'micDi', 'stand'] as const
export type PatchField = (typeof PATCH_FIELDS)[number]

export const PATCH_FIELD_LABELS: Record<PatchField, string> = {
  subBox: 'Sub-box',
  input: 'Input',
  description: 'Description',
  micDi: 'Mic/DI',
  stand: 'Stand',
}

/** A shared row of the sheet ("Channel 1", "Kick", ...). */
export interface Channel {
  id: string
  label: string
}

/** Metadata for a file stored on the relay; the bytes live there, not in the doc. */
export interface ArtistFile {
  id: string
  name: string
  type: string
  size: number
}

export interface Artist {
  id: string
  name: string
  startTime: string
  endTime: string
  notes: string
  files: ArtistFile[]
}

export interface SubBox {
  id: string
  name: string
  inputs: number
  color: string
  stagePosition: string
}

/**
 * One artist's patch for one channel. The sub-box column either references a
 * defined sub-box (subBoxId) or holds free text (subBoxText) — never both.
 */
export interface PatchEntry {
  subBoxId: string | null
  subBoxText: string
  input: string
  description: string
  micDi: string
  stand: string
}

export interface SheetMeta {
  title: string
  stage: string
  /** Plain YYYY-MM-DD string; never round-tripped through Date parsing. */
  date: string
  created: string
}

/** Plain-object view of a sheet document, for rendering, export, and tests. */
export interface SheetSnapshot {
  meta: SheetMeta
  channels: Channel[]
  artists: Artist[]
  subBoxes: SubBox[]
  /** Keyed `${artistId}:${channelId}`. */
  patches: Record<string, PatchEntry>
}

export interface SheetIndexEntry {
  sheetId: string
  title: string
  stage: string
  date: string
  lastModified: string
}

export const patchKey = (artistId: string, channelId: string) => `${artistId}:${channelId}`

export const emptyPatchEntry = (): PatchEntry => ({
  subBoxId: null,
  subBoxText: '',
  input: '',
  description: '',
  micDi: '',
  stand: '',
})

/** True when the entry holds any user content (text or a sub-box reference). */
export const patchEntryHasContent = (entry: PatchEntry | undefined): boolean => {
  if (!entry) return false
  return Object.entries(entry).some(([k, v]) =>
    k === 'subBoxId' ? v !== null : typeof v === 'string' && v !== ''
  )
}
