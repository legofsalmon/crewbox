import * as Y from 'yjs'
import { eventIdFrom, openEvent } from '../eventScope.ts'
import type { RecordsPlugin } from '../server.ts'
import { MOVED_ORIGIN } from './persistence.ts'

/**
 * Edits to the open event's documents that its box isn't known to have, as
 * the apps keep them: in files of the app's own (native RecordsPlugin),
 * beside the event's record (lib/appCopy.ts) and its unsent messages
 * (lib/unsent.ts).
 *
 * A document's own copy is in IndexedDB (lib/docs/store.ts), and an edit
 * made with no box goes out from it when the box is back. A wipe of the web
 * view's storage takes that copy with the rest (lib/appCopy.ts), and until
 * now whatever the box hadn't had went with it: a running order corrected in
 * a dead spot, a sheet filled in on the bus. So the app keeps the part the
 * box lacks, and the page puts it back when the document next opens.
 *
 * What the box has is read from what its relay sends, which needs no change
 * to it (server/src/docs.ts). It opens every connection with its state
 * vector, which shows every insertion it holds, and answers the phone's with
 * every deletion it holds. From then on it sends each change it takes to
 * everybody in the room, the phone that made it included. So of each open
 * document the page knows a floor under what the box has: the last
 * handshake, and everything the relay has sent since.
 *
 * - An edit made while the document isn't in step with the relay (no socket,
 *   or one still shaking hands) is kept: the document encoded against the
 *   relay's state vector as the page last knew it, every deletion included.
 *   That is never more than the document, and applying it twice does
 *   nothing, so it can be generous. With no state vector known, it is the
 *   whole document.
 * - An edit made in step goes out at once, and the relay sends it back
 *   within a round trip. One whose socket drops before then is kept then.
 * - What is kept goes the moment the relay is seen to have all of it: at a
 *   handshake that shows it, or when the relay sends it back.
 * - A document's kept edits are applied as it opens, before it connects, so
 *   after a wipe they go out at its first handshake like any other edit.
 *
 * Only in the apps, and only once the page has read the app's files at its
 * start: one that couldn't doesn't know what they hold, and leaves them for
 * a start that can. Nothing here is needed in a browser, where the open page
 * holds every edit in its documents, and a wipe comes only when somebody
 * asks for one.
 */

/** The slot each event's unconfirmed edits are kept in, beside its record. It reaches phones. */
const EDITS_SLOT = 'doc-edits'

/**
 * The longest a start waits for the app's files, as for its records
 * (lib/appCopy.ts): they answer in milliseconds, and this is for a bridge
 * that never does.
 */
const LOAD_WAIT_MS = 5000

/**
 * How long an edit waits to be kept, so that a burst of typing is one write
 * rather than one a key. The page's own storage has each edit at once, and
 * whatever is waiting is kept the moment the app goes into the background,
 * which is where it gets closed from.
 */
const SETTLE_MS = 1000

/** Stamped on edits put back from the app's files: already kept, and nobody's new edit. */
const KEPT_ORIGIN = Symbol('kept by the app')

/** y-protocols' sync messages, by the number each is sent under. */
const STEP_1 = 0
const STEP_2 = 1
const UPDATE = 2

/** One sync message from the relay: its state vector, or changes it holds. */
export interface RelaySync {
  /** 0 the relay's state vector, 1 its answer to the phone's, 2 a change it took. */
  type: number
  payload: Uint8Array
}

type DeleteSet = ReturnType<typeof Y.createDeleteSet>

/** A room's edits as the app keeps them. */
interface Kept {
  /** The relay's state vector they were encoded against, as the page knew it then. */
  sv: Uint8Array
  /** What the document held beyond it, and every deletion it held. */
  update: Uint8Array
  /** How far the relay has to have got with each client before it can hold them. */
  ends: Map<number, number>
  /** Both, as the app's files have them, once written or read. */
  saved?: { sv: string; update: string }
}

/** What the relay is known to hold of a room, from what it has sent this page. */
interface Relay {
  sv: Map<number, number>
  ds: DeleteSet
  /** Deletions it has sent since `ds` was last brought up to date: merged in when needed. */
  heard: DeleteSet[]
}

/** An open document whose unconfirmed edits the app keeps. */
interface Watched {
  doc: Y.Doc
  /** Null until the relay's first handshake since the document opened. */
  relay: Relay | null
  /** Whether the room is in step with the relay: handshake done, socket up. */
  inStep: boolean
  /** Whether it may hold an edit the app's copy lacks, to be looked at before the next write. */
  due: boolean
  onUpdate: (update: Uint8Array, origin: unknown, doc: Y.Doc, transaction: Y.Transaction) => void
}

/** The app's files, once this page has read them at its start. Nothing is written to them until then. */
let files: RecordsPlugin | undefined

/** Every event's kept edits, by event ID and then room, as this page knows them. */
const kept = new Map<string, Map<string, Kept>>()

/** Events whose kept edits have changed since the app's files were last told. */
const changed = new Set<string>()

/** The open event's documents being watched, by room. */
const watched = new Map<string, Watched>()

/** The open event's ID, if the app can file anything under it. */
function openedHere(): string | undefined {
  const event = openEvent()
  return event === null ? undefined : eventIdFrom(event)
}

function keep(sv: Uint8Array, update: Uint8Array): Kept {
  return { sv, update, ends: Y.parseUpdateMeta(update).to }
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i])

function deletionsOf(relay: Relay): DeleteSet {
  if (relay.heard.length > 0) {
    relay.ds = Y.mergeDeleteSets([relay.ds, ...relay.heard])
    relay.heard = []
  }
  return relay.ds
}

/** Take in changes the relay holds: its insertions, and its deletions. */
function learn(relay: Relay, update: Uint8Array): void {
  const { structs, ds } = Y.decodeUpdate(update)
  for (const struct of structs) {
    // A skip stands for a gap the update doesn't cover, never for content.
    if (struct instanceof Y.Skip) continue
    const { client, clock } = struct.id
    const known = relay.sv.get(client) ?? 0
    // Only what carries on from what the relay is known to have. It takes
    // each client's changes in order, so that means it has everything
    // before them too; anything past a gap may be waiting there on it.
    if (clock <= known && clock + struct.length > known) {
      relay.sv.set(client, clock + struct.length)
    }
  }
  if (ds.clients.size === 0) return
  relay.heard.push(ds)
  if (relay.heard.length >= 256) deletionsOf(relay)
}

/** Whether the relay is known to hold everything kept. */
function holds(relay: Relay, edits: Kept): boolean {
  for (const [client, end] of edits.ends) {
    if ((relay.sv.get(client) ?? 0) < end) return false
  }
  return Y.snapshotContainsUpdate(Y.createSnapshot(deletionsOf(relay), relay.sv), edits.update)
}

/**
 * Bring the app's copy of a room into line with its document: whatever the
 * document holds beyond the relay's state vector as the page knows it,
 * unless the relay is known to hold all of that. Says whether it changed.
 */
function refresh(event: string, room: string, entry: Watched): boolean {
  entry.due = false
  const edits = kept.get(event)
  const before = edits?.get(room)
  const base = entry.relay
    ? Y.encodeStateVector(entry.relay.sv)
    : (before?.sv ?? Y.encodeStateVector(new Map()))
  const now = keep(base, Y.encodeStateAsUpdate(entry.doc, base))
  if (entry.relay && holds(entry.relay, now)) return edits?.delete(room) ?? false
  if (before && sameBytes(before.sv, now.sv) && sameBytes(before.update, now.update)) return false
  if (edits) edits.set(room, now)
  else kept.set(event, new Map([[room, now]]))
  return true
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  // In pieces: a call takes only so many arguments.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function serialize(edits: Map<string, Kept>): string {
  const out: Record<string, { sv: string; update: string }> = {}
  for (const [room, edit] of edits) {
    edit.saved ??= { sv: toBase64(edit.sv), update: toBase64(edit.update) }
    out[room] = edit.saved
  }
  return JSON.stringify(out)
}

/** Settles once every write asked for so far is done: they go one at a time, in order. */
let writing: Promise<unknown> = Promise.resolve()

/** A write asked for and not yet begun, by event: anything changed meanwhile goes with it. */
const waiting = new Map<string, Promise<boolean>>()

/**
 * Write an event's kept edits to the app's files, whole, in place of what
 * was there, looking first at every open document that may have an edit
 * they lack: a slot with nothing in it is removed. Settles to whether the
 * files are as the page has them.
 */
function save(event: string): Promise<boolean> {
  const app = files
  if (!app) return Promise.resolve(false)
  const queued = waiting.get(event)
  if (queued) return queued
  const run = writing.then(async () => {
    waiting.delete(event)
    if (event === openedHere()) {
      for (const [room, entry] of watched) {
        if (entry.due && refresh(event, room, entry)) changed.add(event)
      }
    }
    if (!changed.delete(event)) return true
    const edits = kept.get(event)
    try {
      if (edits && edits.size > 0) {
        await app.write({ event, slot: EDITS_SLOT, value: serialize(edits) })
      } else {
        await app.remove({ event, slot: EDITS_SLOT })
      }
      return true
    } catch {
      // Tried again with the next write.
      changed.add(event)
      return false
    }
  })
  waiting.set(event, run)
  writing = run
  return run
}

/** An edit waiting to be kept (SETTLE_MS). */
let settling: ReturnType<typeof setTimeout> | undefined

function saveSoon(event: string): void {
  if (settling !== undefined) return
  settling = setTimeout(() => {
    settling = undefined
    void save(event)
  }, SETTLE_MS)
}

// The app going into the background, from where it may be closed.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden' || settling === undefined) return
    clearTimeout(settling)
    settling = undefined
    const event = openedHere()
    if (event) void save(event)
  })
}

/**
 * Start keeping an open document's unconfirmed edits, and apply what the app
 * kept of it: called as it starts syncing (lib/docs/sync.ts), before it
 * connects, so that the relay's first handshake is offered them.
 */
export function watchEdits(room: string, doc: Y.Doc): void {
  const event = openedHere()
  if (!files || !event || watched.has(room)) return
  const entry: Watched = { doc, relay: null, inStep: false, due: false, onUpdate: () => {} }
  entry.onUpdate = (_update, origin, _doc, transaction) => {
    // Only this phone's edits: what came from the relay, from the page's
    // storage or from the app's copy is already somewhere else. Another
    // event's work brought across is this phone's to deliver too.
    if (!transaction.local && origin !== MOVED_ORIGIN) return
    if (entry.inStep) return
    entry.due = true
    saveSoon(event)
  }
  watched.set(room, entry)
  const edits = kept.get(event)?.get(room)
  if (edits) {
    try {
      Y.applyUpdate(doc, edits.update, KEPT_ORIGIN)
    } catch {
      kept.get(event)?.delete(room)
      changed.add(event)
      void save(event)
    }
  }
  doc.on('update', entry.onUpdate)
}

/**
 * Stop, as a document closes: whatever it holds that the relay isn't known
 * to have is kept first, while it can still be read.
 */
export function unwatchEdits(room: string): void {
  const entry = watched.get(room)
  if (!entry) return
  entry.doc.off('update', entry.onUpdate)
  watched.delete(room)
  const event = openedHere()
  if (!event || !entry.due) return
  if (refresh(event, room, entry)) changed.add(event)
  void save(event)
}

/**
 * The sync message at `pos` in a frame the provider is about to read, left
 * for it where it is: its type, and its state vector or update. Null for
 * anything that doesn't read as one.
 */
export function readRelaySync(bytes: Uint8Array, pos: number): RelaySync | null {
  const at = { pos }
  const type = readVarUint(bytes, at)
  const length = readVarUint(bytes, at)
  if (type === null || length === null || type > UPDATE) return null
  if (at.pos + length > bytes.length) return null
  return { type, payload: bytes.subarray(at.pos, at.pos + length) }
}

/** lib0's variable-length unsigned integer, as y-protocols writes them. */
function readVarUint(bytes: Uint8Array, at: { pos: number }): number | null {
  let value = 0
  let scale = 1
  while (at.pos < bytes.length) {
    const byte = bytes[at.pos++]!
    value += (byte & 0x7f) * scale
    if (byte < 0x80) return value
    scale *= 128
    if (value > Number.MAX_SAFE_INTEGER) return null
  }
  return null
}

/**
 * What the relay has sent of a room: its state vector at a handshake, which
 * starts the page's knowledge of it afresh, or changes it holds. Whatever
 * was kept goes once the relay is seen to hold all of it.
 */
export function heardFromRelay(room: string, message: RelaySync): void {
  const entry = watched.get(room)
  const event = openedHere()
  if (!entry || !event) return
  try {
    if (message.type === STEP_1) {
      // A box can come back without what it had, so what it said before
      // counts for nothing now.
      entry.relay = { sv: Y.decodeStateVector(message.payload), ds: Y.createDeleteSet(), heard: [] }
    } else if (entry.relay && (message.type === STEP_2 || message.type === UPDATE)) {
      learn(entry.relay, message.payload)
    } else {
      return
    }
  } catch {
    // Nothing the relay sends. Knowing less of it only keeps more.
    entry.relay = null
    return
  }
  // An edit not yet looked at is looked at in the next write, against this.
  if (entry.due) return
  const edits = kept.get(event)
  const mine = edits?.get(room)
  if (mine && holds(entry.relay, mine)) {
    edits!.delete(room)
    changed.add(event)
    void save(event)
  }
}

/**
 * Whether a room is in step with the relay: its handshake done and its
 * socket up. Out of step, whatever it sent that the relay hasn't sent back
 * yet is kept.
 */
export function relayInStep(room: string, inStep: boolean): void {
  const entry = watched.get(room)
  const event = openedHere()
  if (!entry || !event) return
  entry.inStep = inStep
  if (inStep) return
  entry.due = true
  void save(event)
}

/** A document deleted: its kept edits go with it, for nobody is to have them now. */
export function forgetEdits(room: string): void {
  const event = openedHere()
  if (!event) return
  const entry = watched.get(room)
  if (entry) entry.due = false
  if (kept.get(event)?.delete(room)) {
    changed.add(event)
    void save(event)
  }
}

/** An event forgotten: its kept edits go, from the app's files too, even if the page knew of none. */
export async function forgetAllEdits(event: string): Promise<void> {
  const id = eventIdFrom(event)
  if (!id) return
  kept.delete(id)
  changed.add(id)
  await save(id)
}

function parse(text: string): Map<string, Kept> {
  const edits = new Map<string, Kept>()
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return edits
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return edits
  for (const [room, saved] of Object.entries(value)) {
    const { sv, update } = (saved ?? {}) as Record<string, unknown>
    if (typeof sv !== 'string' || typeof update !== 'string') continue
    try {
      const edit = keep(fromBase64(sv), fromBase64(update))
      Y.decodeStateVector(edit.sv)
      edit.saved = { sv, update }
      edits.set(room, edit)
    } catch {
      // Not something this page wrote.
    }
  }
  return edits
}

/**
 * Read the app's files at the start, before any document opens: from then
 * on each document is given what they kept of it as it opens. Settles to
 * whether they could be read, within a few seconds.
 */
export async function loadKeptEdits(app: RecordsPlugin): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let answer: { values?: Record<string, string> }
  try {
    answer = await Promise.race([
      app.readAll({ slot: EDITS_SLOT }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('no answer')), LOAD_WAIT_MS)
      }),
    ])
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
  for (const [event, text] of Object.entries(answer.values ?? {})) {
    const id = eventIdFrom(event)
    if (!id || typeof text !== 'string') continue
    const edits = parse(text)
    if (edits.size > 0) kept.set(id, edits)
  }
  files = app
  return true
}

/** Whether this page read the app's files at its start, and so keeps them in step. */
export function keepsEditsInApp(): boolean {
  return files !== undefined
}
