import type { Act } from '../../../shell/timetable/model.ts'

/** The five patch fields every act has per channel. */
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
 * rather than to any one act, because a festival stage patches the same
 * inputs all day and only the sub-box and the mic change between acts. An
 * act's own `input` overrides it for that act alone.
 */
export interface Channel {
  id: string
  label: string
  input: string
}

/** Metadata for a file stored on the relay; the bytes live there, not in the doc. */
export interface ActFile {
  id: string
  name: string
  type: string
  size: number
}

/**
 * What a sheet knows about an act that the event's timetable does not.
 *
 * Who an act is and when they are on belongs to the running order — it is the
 * same answer for every department. What they need patched is this sheet's
 * business, and a lighting sheet asking the same act a different question
 * must not overwrite it. So the sheet keeps only its own half, keyed by the
 * act's id.
 */
export interface ActExtras {
  actId: string
  /** What the act brings and needs — the "SPEC:" line on a paper sheet. */
  spec: string
  /** Anything else. The "Additional info" box. */
  notes: string
  files: ActFile[]
}

/** An act as a patch sheet sees it: the event's row plus this sheet's own half. */
export type SheetAct = Act & Omit<ActExtras, 'actId'>

export interface SubBox {
  id: string
  name: string
  inputs: number
  color: string
  stagePosition: string
}

/**
 * One act's patch for one channel. The sub-box column either references a
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
  /**
   * Which stage this sheet is for. Load-bearing rather than decorative: it is
   * how the sheet picks its acts out of the event's timetable.
   */
  stage: string
  /** Plain YYYY-MM-DD string; never round-tripped through Date parsing. */
  date: string
  created: string
}

/**
 * Plain-object view of a sheet document, for rendering, export, and tests.
 *
 * There is no act list here, and that absence is the point: the acts come
 * from the shell's timetable. `sheetActs()` in lineup.ts puts the two halves
 * together.
 */
export interface SheetSnapshot {
  meta: SheetMeta
  channels: Channel[]
  subBoxes: SubBox[]
  /** This sheet's own half of each act it has anything to say about, by act id. */
  extras: Record<string, ActExtras>
  /** Keyed `${actId}:${channelId}`. */
  patches: Record<string, PatchEntry>
}

export interface SheetIndexEntry {
  sheetId: string
  title: string
  stage: string
  date: string
  lastModified: string
}

export const patchKey = (actId: string, channelId: string) => `${actId}:${channelId}`

/**
 * Attachments are keyed rather than kept in a list per act, so two people
 * dropping a rider on the same act at the same moment write two different
 * keys and both files survive. A list would be one container written twice.
 */
export const fileKey = (actId: string, fileId: string) => `${actId}:${fileId}`

export const emptyExtras = (actId: string): ActExtras => ({
  actId,
  spec: '',
  notes: '',
  files: [],
})

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
