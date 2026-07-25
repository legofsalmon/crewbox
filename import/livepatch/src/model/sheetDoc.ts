import * as Y from 'yjs'
import {
  emptyPatchEntry,
  patchKey,
  type Artist,
  type ArtistFile,
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

export interface SheetRoots {
  meta: Y.Map<unknown>
  channels: Y.Array<YEntity>
  artists: Y.Array<YEntity>
  subBoxes: Y.Array<YEntity>
  patches: Y.Map<YEntity>
}

export const getSheetRoots = (doc: Y.Doc): SheetRoots => ({
  meta: doc.getMap('meta'),
  channels: doc.getArray<YEntity>('channels'),
  artists: doc.getArray<YEntity>('artists'),
  subBoxes: doc.getArray<YEntity>('subBoxes'),
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
  date?: string
  now?: string
  channelCount?: number
}

/** Populate an empty doc with the default sheet structure. */
export const initSheet = (doc: Y.Doc, options: InitSheetOptions): void => {
  const { meta, channels, artists } = getSheetRoots(doc)
  const now = options.now ?? new Date().toISOString()
  transact(doc, () => {
    meta.set('title', options.title.trim() || 'Untitled Sheet')
    meta.set('stage', '')
    meta.set('date', options.date ?? todayIso())
    meta.set('created', now)
    const count = options.channelCount ?? DEFAULT_CHANNEL_COUNT
    for (let i = 0; i < count; i++) {
      channels.push([mapFrom({ id: crypto.randomUUID(), label: String(i + 1) })])
    }
    artists.push([
      mapFrom({
        id: crypto.randomUUID(),
        name: 'Artist 1',
        startTime: '19:00',
        endTime: '20:00',
        notes: '',
        files: new Y.Array<ArtistFile>(),
      }),
    ])
  })
}

// --- Meta -------------------------------------------------------------------

export const setMetaField = (doc: Y.Doc, field: 'title' | 'stage' | 'date', value: string) => {
  const { meta } = getSheetRoots(doc)
  transact(doc, () => meta.set(field, value))
}

// --- Channels ---------------------------------------------------------------

export const addChannel = (doc: Y.Doc, afterChannelId?: string): string => {
  const { channels } = getSheetRoots(doc)
  const id = crypto.randomUUID()
  transact(doc, () => {
    const index =
      afterChannelId !== undefined ? (findById(channels, afterChannelId)?.index ?? null) : null
    const insertAt = index === null ? channels.length : index + 1
    channels.insert(insertAt, [mapFrom({ id, label: String(channels.length + 1) })])
  })
  return id
}

export const renameChannel = (doc: Y.Doc, channelId: string, label: string) => {
  const { channels } = getSheetRoots(doc)
  transact(doc, () => {
    findById(channels, channelId)?.item.set('label', label)
  })
}

/** Remove a channel and every artist's patch entry for it. */
export const removeChannel = (doc: Y.Doc, channelId: string) => {
  const { channels, patches } = getSheetRoots(doc)
  transact(doc, () => {
    const found = findById(channels, channelId)
    if (!found) return
    channels.delete(found.index)
    for (const key of [...patches.keys()]) {
      if (key.endsWith(`:${channelId}`)) patches.delete(key)
    }
  })
}

// --- Artists ----------------------------------------------------------------

export const addArtist = (doc: Y.Doc): string => {
  const { artists } = getSheetRoots(doc)
  const id = crypto.randomUUID()
  transact(doc, () => {
    artists.push([
      mapFrom({
        id,
        name: `Artist ${artists.length + 1}`,
        startTime: '19:00',
        endTime: '20:00',
        notes: '',
        files: new Y.Array<ArtistFile>(),
      }),
    ])
  })
  return id
}

export const updateArtist = (
  doc: Y.Doc,
  artistId: string,
  fields: Partial<Omit<Artist, 'id' | 'files'>>
) => {
  const { artists } = getSheetRoots(doc)
  transact(doc, () => {
    const found = findById(artists, artistId)
    if (!found) return
    for (const [k, v] of Object.entries(fields)) found.item.set(k, v)
  })
}

/**
 * The files list is a Y.Array created WITH the artist, so concurrent additions
 * from different devices merge instead of overwriting each other. The lazy
 * branch below only covers artists from sheets that predate attachments —
 * concurrent first-attachments on such an artist can lose one file to a
 * container-level last-write-wins, which is accepted for that migration case.
 */
const getOrCreateFiles = (artist: YEntity): Y.Array<ArtistFile> => {
  let files = artist.get('files') as Y.Array<ArtistFile> | undefined
  if (!files) {
    files = new Y.Array<ArtistFile>()
    artist.set('files', files)
  }
  return files
}

export const addArtistFile = (doc: Y.Doc, artistId: string, file: ArtistFile) => {
  const { artists } = getSheetRoots(doc)
  transact(doc, () => {
    const found = findById(artists, artistId)
    if (!found) return
    getOrCreateFiles(found.item).push([file])
  })
}

export const removeArtistFile = (doc: Y.Doc, artistId: string, fileId: string) => {
  const { artists } = getSheetRoots(doc)
  transact(doc, () => {
    const found = findById(artists, artistId)
    if (!found) return
    const files = getOrCreateFiles(found.item)
    for (let i = files.length - 1; i >= 0; i--) {
      if (files.get(i).id === fileId) files.delete(i)
    }
  })
}

/** Remove an artist and all of their patch entries. */
export const removeArtist = (doc: Y.Doc, artistId: string) => {
  const { artists, patches } = getSheetRoots(doc)
  transact(doc, () => {
    const found = findById(artists, artistId)
    if (!found) return
    artists.delete(found.index)
    for (const key of [...patches.keys()]) {
      if (key.startsWith(`${artistId}:`)) patches.delete(key)
    }
  })
}

// --- Sub-boxes --------------------------------------------------------------

export const addSubBox = (doc: Y.Doc, defaults?: Partial<Omit<SubBox, 'id'>>): string => {
  const { subBoxes } = getSheetRoots(doc)
  const id = crypto.randomUUID()
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
  artistId: string,
  channelId: string,
  field: PatchField,
  value: string
) => {
  const entry = getOrCreateEntry(roots.patches, patchKey(artistId, channelId))
  if (field === 'subBox') {
    const match = resolveSubBoxRef(roots.subBoxes, value)
    entry.set('subBoxId', match ? match.id : null)
    entry.set('subBoxText', match ? '' : value)
  } else {
    entry.set(field, value)
  }
}

export const setPatchField = (
  doc: Y.Doc,
  artistId: string,
  channelId: string,
  field: Exclude<PatchField, 'subBox'>,
  value: string
) => {
  const { patches } = getSheetRoots(doc)
  transact(doc, () => {
    getOrCreateEntry(patches, patchKey(artistId, channelId)).set(field, value)
  })
}

// --- Range paste (Google Sheets migration) ----------------------------------

export interface PasteColumn {
  artistId: string
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
        channels.push([mapFrom({ id: crypto.randomUUID(), label: String(channels.length + 1) })])
        addedChannels++
        channelItem = channels.get(channels.length - 1)
      }
      const channelId = channelItem.get('id') as string
      const row = rows[r]
      const width = Math.min(columns.length, row.length)
      for (let c = 0; c < width; c++) {
        writeFieldValue(roots, columns[c].artistId, channelId, columns[c].field, row[c])
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
export const setPatchSubBox = (doc: Y.Doc, artistId: string, channelId: string, raw: string) => {
  const roots = getSheetRoots(doc)
  transact(doc, () => {
    writeFieldValue(roots, artistId, channelId, 'subBox', raw)
  })
}

// --- CSV import -------------------------------------------------------------

export interface ImportedSheetData {
  channels: { label: string }[]
  artists: { name: string }[]
  /** patches[artistIndex][channelIndex] — sparse. */
  patches: Array<Array<Partial<Record<PatchField, string>> | undefined>>
}

/**
 * Populate an empty doc from imported data (see importCsv.ts). One
 * transaction; the caller clears the undo stack afterwards like createSheet.
 */
export const buildImportedSheet = (
  doc: Y.Doc,
  data: ImportedSheetData,
  options: { title: string; now?: string }
): void => {
  const roots = getSheetRoots(doc)
  const { meta, channels, artists } = roots
  const now = options.now ?? new Date().toISOString()
  transact(doc, () => {
    meta.set('title', options.title.trim() || 'Imported Sheet')
    meta.set('stage', '')
    meta.set('date', todayIso())
    meta.set('created', now)

    const channelIds = data.channels.map((channel, i) => {
      const id = crypto.randomUUID()
      channels.push([mapFrom({ id, label: channel.label.trim() || String(i + 1) })])
      return id
    })

    data.artists.forEach((artist, artistIndex) => {
      const artistId = crypto.randomUUID()
      artists.push([
        mapFrom({
          id: artistId,
          name: artist.name.trim() || `Artist ${artistIndex + 1}`,
          startTime: '19:00',
          endTime: '20:00',
          notes: '',
          files: new Y.Array<ArtistFile>(),
        }),
      ])
      const artistPatches = data.patches[artistIndex] ?? []
      artistPatches.forEach((entry, channelIndex) => {
        if (!entry) return
        const channelId = channelIds[channelIndex]
        if (!channelId) return
        for (const [field, value] of Object.entries(entry)) {
          if (value) writeFieldValue(roots, artistId, channelId, field as PatchField, value)
        }
      })
    })
  })
}

/** Copy every patch entry from one artist onto another (overwriting). */
export const copyPatchesFromArtist = (
  doc: Y.Doc,
  sourceArtistId: string,
  targetArtistId: string
) => {
  const { channels, patches } = getSheetRoots(doc)
  transact(doc, () => {
    for (const channel of channels.toArray()) {
      const channelId = channel.get('id') as string
      const source = patches.get(patchKey(sourceArtistId, channelId))
      if (!source) continue
      patches.set(patchKey(targetArtistId, channelId), mapFrom(source.toJSON()))
    }
  })
}

// --- Snapshot ---------------------------------------------------------------

const withEntryDefaults = (raw: Partial<PatchEntry>): PatchEntry => ({
  ...emptyPatchEntry(),
  ...raw,
})

export const snapshotSheet = (doc: Y.Doc): SheetSnapshot => {
  const { meta, channels, artists, subBoxes, patches } = getSheetRoots(doc)
  const patchesJson: Record<string, PatchEntry> = {}
  for (const [key, entry] of patches.entries()) {
    patchesJson[key] = withEntryDefaults(entry.toJSON() as Partial<PatchEntry>)
  }
  return {
    meta: {
      title: (meta.get('title') as string) ?? '',
      stage: (meta.get('stage') as string) ?? '',
      date: (meta.get('date') as string) ?? '',
      created: (meta.get('created') as string) ?? '',
    } satisfies SheetMeta,
    channels: channels.toArray().map((m) => m.toJSON() as Channel),
    artists: artists
      .toArray()
      .map((m) => ({ files: [], ...(m.toJSON() as Omit<Artist, 'files'>) })),
    subBoxes: subBoxes.toArray().map((m) => m.toJSON() as SubBox),
    patches: patchesJson,
  }
}

/**
 * Rewrite the five editable roots to exactly match a snapshot. Ids are
 * preserved, so patch keys and sub-box references stay valid. One transaction
 * with LOCAL_ORIGIN — restoring a saved version is a single undoable step.
 */
export const applySnapshot = (doc: Y.Doc, snapshot: SheetSnapshot): void => {
  const { meta, channels, artists, subBoxes, patches } = getSheetRoots(doc)
  transact(doc, () => {
    meta.set('title', snapshot.meta.title)
    meta.set('stage', snapshot.meta.stage)
    meta.set('date', snapshot.meta.date)
    meta.set('created', snapshot.meta.created)
    channels.delete(0, channels.length)
    channels.push(snapshot.channels.map((channel) => mapFrom({ ...channel })))
    artists.delete(0, artists.length)
    artists.push(
      snapshot.artists.map(({ files, ...artist }) => {
        const filesArray = new Y.Array<ArtistFile>()
        if (files.length > 0) filesArray.push([...files])
        return mapFrom({ ...artist, files: filesArray })
      })
    )
    subBoxes.delete(0, subBoxes.length)
    subBoxes.push(snapshot.subBoxes.map((subBox) => mapFrom({ ...subBox })))
    for (const key of [...patches.keys()]) patches.delete(key)
    for (const [key, entry] of Object.entries(snapshot.patches)) {
      patches.set(key, mapFrom(entry as unknown as Record<string, unknown>))
    }
  })
}

/** The text a patch cell's sub-box column should display. */
export const patchSubBoxDisplay = (entry: PatchEntry, subBoxes: SubBox[]): string => {
  if (entry.subBoxId) {
    const sb = subBoxes.find((s) => s.id === entry.subBoxId)
    if (sb) return subBoxDisplayName(sb)
  }
  return entry.subBoxText
}
