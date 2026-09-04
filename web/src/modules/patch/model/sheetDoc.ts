import { newId } from '@crewbox/shared'
import * as Y from 'yjs'
import { addAct, upsertAct } from '../../../shell/timetable/model.ts'
import {
  emptyExtras,
  emptyPatchEntry,
  fileKey,
  patchKey,
  type ActExtras,
  type ActFile,
  type Channel,
  type PatchEntry,
  type PatchField,
  type SheetMeta,
  type SheetSnapshot,
  type SubBox,
} from './types'
import { DEFAULT_CHANNEL_COUNT, STAGE_POSITIONS } from './constants'
import { todayIso } from './date'

/**
 * Transaction origin for edits made by this client through the ops below.
 * The store layer uses it to distinguish local edits (which should bump the
 * sheet's lastModified in the index) from updates arriving from IndexedDB
 * load or remote sync.
 */
export const LOCAL_ORIGIN = 'livepatch-local'

type YEntity = Y.Map<unknown>

/**
 * The sheet's roots.
 *
 * There is no act list. Who is on and when belongs to the event's timetable
 * in the shell, and a sheet picks its own acts out of it by stage and date
 * (see lineup.ts). What is left here is what only this sheet knows: its
 * channels, its sub-boxes, the patch itself, and the spec/notes/riders it
 * keeps against each act.
 */
export interface SheetRoots {
  meta: Y.Map<unknown>
  channels: Y.Array<YEntity>
  subBoxes: Y.Array<YEntity>
  /** actId → { spec, notes }. Keyed, because order comes from the timetable. */
  extras: Y.Map<YEntity>
  /** `${actId}:${fileId}` → ActFile. */
  files: Y.Map<YEntity>
  patches: Y.Map<YEntity>
}

export const getSheetRoots = (doc: Y.Doc): SheetRoots => ({
  meta: doc.getMap('meta'),
  channels: doc.getArray<YEntity>('channels'),
  subBoxes: doc.getArray<YEntity>('subBoxes'),
  extras: doc.getMap<YEntity>('extras'),
  files: doc.getMap<YEntity>('files'),
  patches: doc.getMap<YEntity>('patches'),
})

const mapFrom = (obj: Record<string, unknown>): YEntity => {
  const map = new Y.Map<unknown>()
  for (const [k, v] of Object.entries(obj)) map.set(k, v)
  return map
}

const transact = (doc: Y.Doc, fn: () => void) => doc.transact(fn, LOCAL_ORIGIN)

/**
 * Undo/redo across the whole sheet, tracking ONLY this client's edits (every
 * op above transacts with LOCAL_ORIGIN). Remote updates arrive with other
 * origins and are never undone — you take back your own change, not a
 * collaborator's. captureTimeout groups edits landing within one beat; the
 * blur/Enter commit cadence keeps distinct edits as distinct steps.
 *
 * The timetable is a different document with its own undo manager, so
 * Ctrl+Z in a sheet never reaches back and moves an act's set time.
 */
export const createSheetUndoManager = (doc: Y.Doc): Y.UndoManager =>
  new Y.UndoManager(Object.values(getSheetRoots(doc)) as Y.AbstractType<unknown>[], {
    trackedOrigins: new Set([LOCAL_ORIGIN]),
    captureTimeout: 300,
  })

const findById = (arr: Y.Array<YEntity>, id: string): { item: YEntity; index: number } | null => {
  for (let i = 0; i < arr.length; i++) {
    const item = arr.get(i)
    if (item.get('id') === id) return { item, index: i }
  }
  return null
}

// --- Creation ---------------------------------------------------------------

export interface InitSheetOptions {
  title: string
  /**
   * The stage this sheet covers. Defaults to the title, because a sheet named
   * "Main Stage" is a stage called Main Stage, and a sheet that shares its
   * stage with every other sheet on the box would show every other sheet's
   * acts. Both are one field away from being renamed.
   */
  stage?: string
  date?: string
  now?: string
  channelCount?: number
}

/**
 * Populate an empty doc with the default sheet structure, and put its first
 * act on the running order.
 *
 * The act goes in the timetable rather than here — a sheet with no acts is a
 * grid with no columns, and the first thing anyone does with a new sheet is
 * type a patch against somebody.
 */
export const initSheet = (doc: Y.Doc, timetableDoc: Y.Doc, options: InitSheetOptions): void => {
  const { meta, channels } = getSheetRoots(doc)
  const now = options.now ?? new Date().toISOString()
  const stage = (options.stage ?? options.title).trim()
  const date = options.date ?? todayIso()
  transact(doc, () => {
    meta.set('title', options.title.trim() || 'Untitled Sheet')
    meta.set('stage', stage)
    meta.set('date', date)
    meta.set('created', now)
    const count = options.channelCount ?? DEFAULT_CHANNEL_COUNT
    for (let i = 0; i < count; i++) {
      channels.push([mapFrom({ id: newId(), label: String(i + 1), input: '' })])
    }
  })
  addAct(timetableDoc, { name: 'Act 1', stage, date, start: '19:00', end: '20:00' })
}

// --- Meta -------------------------------------------------------------------

export const setMetaField = (doc: Y.Doc, field: 'title' | 'stage' | 'date', value: string) => {
  const { meta } = getSheetRoots(doc)
  transact(doc, () => meta.set(field, value))
}

// --- Channels ---------------------------------------------------------------

/**
 * Make every plainly-numbered channel's label match its position again.
 *
 * A channel number is a desk input number: the fourth row is input 4, and if
 * a row is inserted above it, it becomes input 5. So the numbers follow the
 * list rather than the list following the numbers.
 *
 * Anything a human typed is left exactly alone — "SUB L", "1A", "Talkback".
 * Only labels that are purely digits are positional, because only those can
 * be read as "this is input N" in the first place. That does mean a named
 * channel occupies a position and the numbers step over it, which is right:
 * the row below a named row is still the row it physically is.
 *
 * Callers must already be inside a transaction, so an insert and the
 * renumbering it causes undo as one action rather than two.
 */
const renumberChannels = (channels: Y.Array<YEntity>): void => {
  for (let i = 0; i < channels.length; i++) {
    const channel = channels.get(i)
    const label = String(channel.get('label') ?? '')
    if (!/^\d+$/.test(label)) continue
    const positional = String(i + 1)
    // Only write when it actually changes: every set is a CRDT update that
    // ships to every other device on the box.
    if (label !== positional) channel.set('label', positional)
  }
}

export const addChannel = (doc: Y.Doc, afterChannelId?: string): string => {
  const { channels } = getSheetRoots(doc)
  const id = newId()
  transact(doc, () => {
    const index =
      afterChannelId !== undefined ? (findById(channels, afterChannelId)?.index ?? null) : null
    const insertAt = index === null ? channels.length : index + 1
    // A placeholder number; renumbering below gives it the right one, and
    // gives it to everything under it too.
    channels.insert(insertAt, [mapFrom({ id, label: String(insertAt + 1), input: '' })])
    renumberChannels(channels)
  })
  return id
}

export const renameChannel = (doc: Y.Doc, channelId: string, label: string) => {
  const { channels } = getSheetRoots(doc)
  transact(doc, () => {
    findById(channels, channelId)?.item.set('label', label)
  })
}

/**
 * Set the house input on a channel — the name that is the same all day.
 *
 * This is the sheet's spine: a festival stage patches KICK IN on 1 whoever is
 * playing, and only the sub-box and the mic change between acts. Keeping it
 * here rather than in every act's column is the difference between typing
 * it once and typing it once per act.
 */
export const setChannelInput = (doc: Y.Doc, channelId: string, input: string) => {
  const { channels } = getSheetRoots(doc)
  transact(doc, () => {
    findById(channels, channelId)?.item.set('input', input)
  })
}

/** Remove a channel and every act's patch entry for it. */
export const removeChannel = (doc: Y.Doc, channelId: string) => {
  const { channels, patches } = getSheetRoots(doc)
  transact(doc, () => {
    const found = findById(channels, channelId)
    if (!found) return
    channels.delete(found.index)
    for (const key of [...patches.keys()]) {
      if (key.endsWith(`:${channelId}`)) patches.delete(key)
    }
    renumberChannels(channels)
  })
}

// --- What the sheet keeps about an act --------------------------------------

/** Must run inside a transaction. */
const getOrCreateExtras = (extras: Y.Map<YEntity>, actId: string): YEntity => {
  let entry = extras.get(actId)
  if (!entry) {
    entry = mapFrom({ actId, spec: '', notes: '' })
    extras.set(actId, entry)
  }
  return entry
}

/**
 * Write the spec or the notes for an act on this sheet.
 *
 * Two fields, not one, because a paper sheet has two and they hold different
 * things: the spec is what the act brings and needs, and gets read before the
 * day; the notes are whatever came up, and get read on it.
 */
export const setActExtra = (
  doc: Y.Doc,
  actId: string,
  field: 'spec' | 'notes',
  value: string
): void => {
  const { extras } = getSheetRoots(doc)
  transact(doc, () => getOrCreateExtras(extras, actId).set(field, value))
}

export const addActFile = (doc: Y.Doc, actId: string, file: ActFile): void => {
  const { files } = getSheetRoots(doc)
  transact(doc, () => files.set(fileKey(actId, file.id), mapFrom({ ...file, actId })))
}

export const removeActFile = (doc: Y.Doc, actId: string, fileId: string): void => {
  const { files } = getSheetRoots(doc)
  transact(doc, () => files.delete(fileKey(actId, fileId)))
}

/**
 * Forget everything this sheet holds about an act.
 *
 * Called when someone takes the act off the running order from here: the act
 * leaves the event, and the sheet that removed it clears its own half in the
 * same breath rather than leaving a column's worth of patch stranded behind
 * an id nothing points at any more.
 */
export const clearActFromSheet = (doc: Y.Doc, actId: string): void => {
  const { extras, files, patches } = getSheetRoots(doc)
  transact(doc, () => {
    extras.delete(actId)
    for (const key of [...files.keys()]) {
      if (key.startsWith(`${actId}:`)) files.delete(key)
    }
    for (const key of [...patches.keys()]) {
      if (key.startsWith(`${actId}:`)) patches.delete(key)
    }
  })
}

// --- Sub-boxes --------------------------------------------------------------

export const addSubBox = (doc: Y.Doc, defaults?: Partial<Omit<SubBox, 'id'>>): string => {
  const { subBoxes } = getSheetRoots(doc)
  const id = newId()
  transact(doc, () => {
    subBoxes.push([
      mapFrom({
        id,
        name: defaults?.name ?? `Sub-box ${subBoxes.length + 1}`,
        inputs: defaults?.inputs ?? 4,
        color: defaults?.color ?? '#ff0000',
        stagePosition: defaults?.stagePosition ?? STAGE_POSITIONS[3], // MSC
      }),
    ])
  })
  return id
}

export const updateSubBox = (doc: Y.Doc, subBoxId: string, fields: Partial<Omit<SubBox, 'id'>>) => {
  const { subBoxes } = getSheetRoots(doc)
  transact(doc, () => {
    const found = findById(subBoxes, subBoxId)
    if (!found) return
    for (const [k, v] of Object.entries(fields)) found.item.set(k, v)
  })
}

/**
 * Remove a sub-box. Patch cells referencing it keep their content by
 * converting the reference into free text (the sub-box's display name).
 */
export const removeSubBox = (doc: Y.Doc, subBoxId: string) => {
  const { subBoxes, patches } = getSheetRoots(doc)
  transact(doc, () => {
    const found = findById(subBoxes, subBoxId)
    if (!found) return
    const display = subBoxDisplayName(found.item.toJSON() as SubBox)
    subBoxes.delete(found.index)
    for (const entry of patches.values()) {
      if (entry.get('subBoxId') === subBoxId) {
        entry.set('subBoxId', null)
        entry.set('subBoxText', display)
      }
    }
  })
}

/** "Name (POS)" when a stage position is set, otherwise just the name. */
export const subBoxDisplayName = (subBox: Pick<SubBox, 'name' | 'stagePosition'>): string =>
  subBox.stagePosition ? `${subBox.name} (${subBox.stagePosition})` : subBox.name

/**
 * Split "BSNAKE 7" into the box and the tail on it.
 *
 * A trailing number is the tail. A box whose whole name is a number isn't
 * split, because "12" on its own names nothing — it would turn a cell reading
 * "12" into tail 12 of a box with no name.
 */
export const splitSubBoxRef = (raw: string): { base: string; tail: number | null } => {
  const trimmed = raw.trim()
  const match = /^(.*?)[\s-]*(\d+)$/.exec(trimmed)
  const base = match?.[1]?.trim() ?? ''
  if (!match || !base) return { base: trimmed, tail: null }
  return { base, tail: Number(match[2]) }
}

// --- Patches ----------------------------------------------------------------

const getOrCreateEntry = (patches: Y.Map<YEntity>, key: string): YEntity => {
  let entry = patches.get(key)
  if (!entry) {
    entry = mapFrom(emptyPatchEntry() as unknown as Record<string, unknown>)
    patches.set(key, entry)
  }
  return entry
}

/** Match raw text against defined sub-boxes (bare name or display name). */
const resolveSubBoxRef = (subBoxes: Y.Array<YEntity>, raw: string): SubBox | undefined => {
  const needle = raw.trim().toLowerCase()
  if (!needle) return undefined
  return subBoxes
    .toArray()
    .map((m) => m.toJSON() as SubBox)
    .find(
      (sb) =>
        sb.name.trim().toLowerCase() === needle ||
        subBoxDisplayName(sb).trim().toLowerCase() === needle
    )
}

/** Write one field of one entry. Must run inside a transaction. */
const writeFieldValue = (
  roots: SheetRoots,
  actId: string,
  channelId: string,
  field: PatchField,
  value: string
) => {
  const entry = getOrCreateEntry(roots.patches, patchKey(actId, channelId))
  if (field === 'subBox') {
    // The whole string is tried first, so a box someone genuinely named
    // "SB 1" still resolves and sheets written before tails existed keep
    // meaning what they meant. Only then is a trailing number read as a tail.
    const whole = resolveSubBoxRef(roots.subBoxes, value)
    if (whole) {
      entry.set('subBoxId', whole.id)
      entry.set('subBoxText', '')
      entry.set('subBoxTail', null)
      return
    }
    const { base, tail } = splitSubBoxRef(value)
    const match = resolveSubBoxRef(roots.subBoxes, base)
    entry.set('subBoxId', match ? match.id : null)
    entry.set('subBoxText', match ? '' : base)
    entry.set('subBoxTail', tail)
  } else {
    entry.set(field, value)
  }
}

export const setPatchField = (
  doc: Y.Doc,
  actId: string,
  channelId: string,
  field: Exclude<PatchField, 'subBox'>,
  value: string
) => {
  const { patches } = getSheetRoots(doc)
  transact(doc, () => {
    getOrCreateEntry(patches, patchKey(actId, channelId)).set(field, value)
  })
}

// --- Range paste (Google Sheets migration) ----------------------------------

export interface PasteColumn {
  actId: string
  field: PatchField
}

/**
 * Apply a rectangular block of values (e.g. pasted from Google Sheets) with
 * the top-left cell at `startChannelId` × `columns[0]`. Rows beyond the last
 * channel append new channels; values beyond `columns` are dropped by the
 * caller. One transaction — a single undo step reverts the whole paste.
 */
export const pasteGrid = (
  doc: Y.Doc,
  startChannelId: string,
  columns: PasteColumn[],
  rows: string[][]
): { addedChannels: number; writtenCells: number } => {
  const roots = getSheetRoots(doc)
  const { channels } = roots
  let addedChannels = 0
  let writtenCells = 0
  transact(doc, () => {
    const start = findById(channels, startChannelId)
    if (!start) return
    for (let r = 0; r < rows.length; r++) {
      const index = start.index + r
      let channelItem: YEntity
      if (index < channels.length) {
        channelItem = channels.get(index)
      } else {
        channels.push([mapFrom({ id: newId(), label: String(channels.length + 1) })])
        addedChannels++
        channelItem = channels.get(channels.length - 1)
      }
      const channelId = channelItem.get('id') as string
      const row = rows[r]
      const width = Math.min(columns.length, row.length)
      for (let c = 0; c < width; c++) {
        writeFieldValue(roots, columns[c].actId, channelId, columns[c].field, row[c])
        writtenCells++
      }
    }
  })
  return { addedChannels, writtenCells }
}

/**
 * Set the sub-box cell from raw user text. If the text matches a defined
 * sub-box (by display name or bare name, case-insensitively), the cell stores
 * a reference to it; otherwise it stores the text as-is.
 */
export const setPatchSubBox = (doc: Y.Doc, actId: string, channelId: string, raw: string) => {
  const roots = getSheetRoots(doc)
  transact(doc, () => {
    writeFieldValue(roots, actId, channelId, 'subBox', raw)
  })
}

// --- CSV import -------------------------------------------------------------

export interface ImportedSheetData {
  /** `input` is the house input on that channel, shared by every act. */
  channels: { label: string; input?: string }[]
  /**
   * The acts the file names. These land on the event's running order, not in
   * the sheet — importing a festival's master patch is how a box learns the
   * day's timetable, and it would be a shame for that to stay in audio.
   */
  acts: {
    name: string
    start?: string
    end?: string
    changeover?: number
    spec?: string
    notes?: string
  }[]
  /** Sub-boxes the file declared, so cells resolve to them rather than to text. */
  subBoxes?: Array<Omit<SubBox, 'id'>>
  /** patches[actIndex][channelIndex] — sparse. */
  patches: Array<Array<Partial<Record<PatchField, string>> | undefined>>
}

/** Must run inside a transaction. */
const setSpecOrNotes = (
  roots: SheetRoots,
  actId: string,
  field: 'spec' | 'notes',
  value: string
) => {
  getOrCreateExtras(roots.extras, actId).set(field, value)
}

/**
 * Populate an empty doc from imported data (see importCsv.ts), putting its
 * acts on the running order. One transaction per document; the caller clears
 * the undo stack afterwards like createSheet.
 */
export const buildImportedSheet = (
  doc: Y.Doc,
  timetableDoc: Y.Doc,
  data: ImportedSheetData,
  options: { title: string; stage?: string; date?: string; now?: string }
): void => {
  const roots = getSheetRoots(doc)
  const { meta, channels } = roots
  const now = options.now ?? new Date().toISOString()
  const title = options.title.trim() || 'Imported Sheet'
  const stage = (options.stage ?? title).trim()
  const date = options.date ?? todayIso()

  // The acts go in first and outside the sheet's transaction: they are a
  // different document, and the ids they come back with are what the patch
  // cells below are keyed by.
  //
  // Upsert rather than append, and only the fields the file actually filled
  // in: importing the same running order twice — a second sheet for the same
  // stage, a re-import after a correction — must reconcile with the day
  // that is already there rather than listing it again. Blank cells say
  // nothing, so they leave a time somebody fixed by hand alone.
  const actIds = data.acts.map((act) =>
    upsertAct(timetableDoc, {
      name: act.name.trim() || 'Act',
      stage,
      date,
      ...(act.start ? { start: act.start } : {}),
      ...(act.end ? { end: act.end } : {}),
      ...(act.changeover ? { changeover: act.changeover } : {}),
    })
  )

  transact(doc, () => {
    meta.set('title', title)
    meta.set('stage', stage)
    meta.set('date', date)
    meta.set('created', now)

    // Sub-boxes go in before any patch cell is written: `writeFieldValue`
    // resolves a cell's text against the defined boxes, so a box that arrives
    // afterwards leaves every cell that named it stranded as free text.
    for (const subBox of data.subBoxes ?? []) {
      roots.subBoxes.push([mapFrom({ id: newId(), ...subBox })])
    }

    const channelIds = data.channels.map((channel, i) => {
      const id = newId()
      channels.push([
        mapFrom({ id, label: channel.label.trim() || String(i + 1), input: channel.input ?? '' }),
      ])
      return id
    })

    data.acts.forEach((act, actIndex) => {
      const actId = actIds[actIndex]!
      if (act.spec) setSpecOrNotes(roots, actId, 'spec', act.spec)
      if (act.notes) setSpecOrNotes(roots, actId, 'notes', act.notes)
      const actPatches = data.patches[actIndex] ?? []
      actPatches.forEach((entry, channelIndex) => {
        if (!entry) return
        const channelId = channelIds[channelIndex]
        if (!channelId) return
        for (const [field, value] of Object.entries(entry)) {
          if (value) writeFieldValue(roots, actId, channelId, field as PatchField, value)
        }
      })
    })
  })
}

/** Copy every patch entry from one act onto another (overwriting). */
export const copyPatchesFromAct = (doc: Y.Doc, sourceActId: string, targetActId: string) => {
  const { channels, patches } = getSheetRoots(doc)
  transact(doc, () => {
    for (const channel of channels.toArray()) {
      const channelId = channel.get('id') as string
      const source = patches.get(patchKey(sourceActId, channelId))
      if (!source) continue
      patches.set(patchKey(targetActId, channelId), mapFrom(source.toJSON()))
    }
  })
}

// --- Snapshot ---------------------------------------------------------------

const withEntryDefaults = (raw: Partial<PatchEntry>): PatchEntry => ({
  ...emptyPatchEntry(),
  ...raw,
})

export const snapshotSheet = (doc: Y.Doc): SheetSnapshot => {
  const { meta, channels, subBoxes, extras, files, patches } = getSheetRoots(doc)
  const patchesJson: Record<string, PatchEntry> = {}
  for (const [key, entry] of patches.entries()) {
    patchesJson[key] = withEntryDefaults(entry.toJSON() as Partial<PatchEntry>)
  }

  // Defaults first, so a doc written before a field existed reads back with
  // an empty one rather than `undefined` reaching the UI. The casts are to
  // Partial deliberately: the stored maps genuinely lack these keys, and
  // claiming otherwise is what would let `undefined` through.
  const extrasJson: Record<string, ActExtras> = {}
  for (const [actId, entry] of extras.entries()) {
    extrasJson[actId] = { ...emptyExtras(actId), ...(entry.toJSON() as Partial<ActExtras>) }
  }
  for (const entry of files.values()) {
    const file = entry.toJSON() as ActFile & { actId: string }
    const held = (extrasJson[file.actId] ??= emptyExtras(file.actId))
    held.files = [...held.files, { id: file.id, name: file.name, type: file.type, size: file.size }]
  }

  return {
    meta: {
      title: (meta.get('title') as string) ?? '',
      stage: (meta.get('stage') as string) ?? '',
      date: (meta.get('date') as string) ?? '',
      created: (meta.get('created') as string) ?? '',
    } satisfies SheetMeta,
    channels: channels
      .toArray()
      .map((m) => ({ input: '', ...(m.toJSON() as Partial<Channel>) }) as Channel),
    subBoxes: subBoxes.toArray().map((m) => m.toJSON() as SubBox),
    extras: extrasJson,
    patches: patchesJson,
  }
}

/**
 * Rewrite the editable roots to exactly match a snapshot. Ids are preserved,
 * so patch keys and sub-box references stay valid. One transaction with
 * LOCAL_ORIGIN — restoring a saved version is a single undoable step.
 *
 * The running order is not touched. A saved version is a version of *this
 * sheet*, and restoring one must not reach across and move set times for
 * every other department on the box.
 *
 * **Which is why `stage` and `date` are not restored either.** Those two are
 * not the sheet's own content; they are the join to the running order — how
 * the sheet finds its columns. Putting back an old pair while every act
 * stayed where it is disconnects the sheet from its acts, and the result is
 * a blank grid with nothing saying why. The toolbar can change them, and
 * moves the acts when it does (see `setSheetDate` and `setSheetStage`); a
 * restore has no business doing half of that.
 *
 * So a restore puts back what somebody actually saved a version of — the
 * channels, the patch, the specs, the notes, the files — and leaves the sheet
 * pointing at the stage and day it is currently for.
 */
export const applySnapshot = (doc: Y.Doc, snapshot: SheetSnapshot): void => {
  const { meta, channels, subBoxes, extras, files, patches } = getSheetRoots(doc)
  transact(doc, () => {
    meta.set('title', snapshot.meta.title)
    meta.set('created', snapshot.meta.created)
    channels.delete(0, channels.length)
    channels.push(snapshot.channels.map((channel) => mapFrom({ ...channel })))
    subBoxes.delete(0, subBoxes.length)
    subBoxes.push(snapshot.subBoxes.map((subBox) => mapFrom({ ...subBox })))

    for (const key of [...extras.keys()]) extras.delete(key)
    for (const key of [...files.keys()]) files.delete(key)
    for (const held of Object.values(snapshot.extras)) {
      extras.set(held.actId, mapFrom({ actId: held.actId, spec: held.spec, notes: held.notes }))
      for (const file of held.files) {
        files.set(fileKey(held.actId, file.id), mapFrom({ ...file, actId: held.actId }))
      }
    }

    for (const key of [...patches.keys()]) patches.delete(key)
    for (const [key, entry] of Object.entries(snapshot.patches)) {
      patches.set(key, mapFrom(entry as unknown as Record<string, unknown>))
    }
  })
}

/**
 * The text a patch cell's sub-box column should display.
 *
 * The cell is an editable input: whatever this returns is what gets committed
 * back through `setPatchSubBox` when someone tabs out of it, so it has to be
 * something that parses back to the same thing. That is why a tailed cell
 * drops the "(POS)" suffix — "PINK 7 (USC)" would not re-resolve, and a cell
 * that quietly loses its sub-box reference on a stray keystroke is worse than
 * one that doesn't repeat the stage position it already shows in the manager.
 */
export const patchSubBoxDisplay = (entry: PatchEntry, subBoxes: SubBox[]): string => {
  const box = entry.subBoxId ? subBoxes.find((s) => s.id === entry.subBoxId) : undefined
  if (entry.subBoxTail === null) return box ? subBoxDisplayName(box) : entry.subBoxText
  return `${box ? box.name : entry.subBoxText} ${entry.subBoxTail}`.trim()
}
