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

/**
 * A shared row of the sheet.
 *
 * `label` is the desk input number ("1", "12") or a name someone typed for a
 * row that isn't numbered ("SUB L", "Talkback"). `input` is the house input
 * on that channel — "KICK IN", "FRONT VOX 1" — and belongs to the sheet
 * rather than to any one artist, because a festival stage patches the same
 * inputs all day and only the sub-box and the mic change between acts. An
 * artist's own `input` overrides it for that act alone.
 */
export interface Channel {
  id: string
  label: string
  input: string
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
  /**
   * Minutes between the previous act coming down and this one going on.
   *
   * 0 when nothing says — including for the first act of the day, which has
   * no act before it to change over from. See `changeover.ts`.
   */
  changeover: number
  /** What the act brings and needs — the "SPEC:" line on a paper sheet. */
  spec: string
  /** Anything else. The "Additional info" box. */
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
 *
 * `subBoxTail` is which numbered tail on that box — the 7 in "BSNAKE 7". It
 * is what turns the sheet round: with it, "which channel is P7" can be
 * answered by reading the cells instead of by keeping a second table by hand.
 * Null when nobody said, which is normal for a box referred to by name only.
 */
export interface PatchEntry {
  subBoxId: string | null
  subBoxText: string
  subBoxTail: number | null
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
  subBoxTail: null,
  input: '',
  description: '',
  micDi: '',
  stand: '',
})

/** True when the entry holds any user content (text or a sub-box reference). */
export const patchEntryHasContent = (entry: PatchEntry | undefined): boolean => {
  if (!entry) return false
  return Object.entries(entry).some(([k, v]) =>
    k === 'subBoxId' || k === 'subBoxTail' ? v !== null : typeof v === 'string' && v !== ''
  )
}
