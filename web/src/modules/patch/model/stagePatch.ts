import { patchKey, type Channel, type PatchEntry, type SheetSnapshot, type SubBox } from './types'

/**
 * The sheet read from the stage end instead of the desk end.
 *
 * The grid answers "what is channel 12 for this act". Standing on the deck
 * with a fistful of tails you have the opposite question — "this is P7, where
 * does it go" — and on paper that means keeping a second table, one row per
 * tail per box per act, filled in by hand. A festival sheet with five 12-way
 * boxes and seven acts is 420 cells of it, maintained in parallel with the
 * grid and wrong the moment one of them changes.
 *
 * It doesn't need to be a second table. Every cell already says which box and
 * which tail; this turns that round and derives the whole thing.
 */

export interface TailRow {
  tail: number
  /** The channel this tail feeds, or null when nothing is patched to it. */
  channel: Channel | null
  /** What's on it — the act's own input if set, else the house input. */
  input: string
  micDi: string
  /**
   * Other channels also claiming this tail. Two things down one tail is a
   * real mistake and the paper version hides it completely, because you only
   * ever write one channel number in the box.
   */
  clashes: Channel[]
}

export interface BoxRun {
  /** The defined sub-box, or null when the cells only name it as text. */
  subBox: SubBox | null
  name: string
  color: string
  stagePosition: string
  rows: TailRow[]
  /** Tails with something patched to them. */
  used: number
}

/** What an act's cell says its input is, falling back to the house input. */
export const effectiveInput = (entry: PatchEntry | undefined, channel: Channel): string =>
  entry?.input?.trim() ? entry.input : channel.input

/**
 * Every sub-box run for one act, in sheet order.
 *
 * Defined sub-boxes come first and always appear, at their full width, so a
 * half-used 12-way box still shows its five empty tails — the empties are the
 * point when you are deciding where to put the next thing. Boxes that only
 * exist as text in cells follow, listing just the tails actually used, since
 * nothing says how big they are.
 */
export function stagePatchFor(snapshot: SheetSnapshot, actId: string): BoxRun[] {
  const { channels, subBoxes, patches } = snapshot

  /** Box key → tail → channels claiming it. */
  const claims = new Map<string, Map<number, Channel[]>>()
  const textBoxes = new Map<string, string>()

  for (const channel of channels) {
    const entry = patches[patchKey(actId, channel.id)]
    if (!entry || entry.subBoxTail === null) continue
    const key = entry.subBoxId ?? `text:${entry.subBoxText.trim().toLowerCase()}`
    if (!entry.subBoxId) {
      if (!entry.subBoxText.trim()) continue
      textBoxes.set(key, entry.subBoxText.trim())
    }
    const byTail = claims.get(key) ?? new Map<number, Channel[]>()
    byTail.set(entry.subBoxTail, [...(byTail.get(entry.subBoxTail) ?? []), channel])
    claims.set(key, byTail)
  }

  const rowFor = (tail: number, byTail: Map<number, Channel[]> | undefined): TailRow => {
    const claiming = byTail?.get(tail) ?? []
    const [channel, ...clashes] = claiming
    const entry = channel ? patches[patchKey(actId, channel.id)] : undefined
    return {
      tail,
      channel: channel ?? null,
      input: channel ? effectiveInput(entry, channel) : '',
      micDi: entry?.micDi ?? '',
      clashes,
    }
  }

  const runs: BoxRun[] = subBoxes.map((subBox) => {
    const byTail = claims.get(subBox.id)
    const rows = Array.from({ length: Math.max(1, subBox.inputs) }, (_, i) => rowFor(i + 1, byTail))
    return {
      subBox,
      name: subBox.name,
      color: subBox.color,
      stagePosition: subBox.stagePosition,
      rows,
      used: rows.filter((row) => row.channel !== null).length,
    }
  })

  for (const [key, name] of textBoxes) {
    const byTail = claims.get(key)
    if (!byTail) continue
    const tails = [...byTail.keys()].sort((a, b) => a - b)
    const rows = tails.map((tail) => rowFor(tail, byTail))
    runs.push({
      subBox: null,
      name,
      color: '',
      stagePosition: '',
      rows,
      used: rows.filter((row) => row.channel !== null).length,
    })
  }

  return runs
}

/** Every tail claimed by more than one channel, for the warning line. */
export function stagePatchClashes(runs: BoxRun[]): Array<{ box: string; tail: number }> {
  const out: Array<{ box: string; tail: number }> = []
  for (const run of runs) {
    for (const row of run.rows) {
      if (row.clashes.length > 0) out.push({ box: run.name, tail: row.tail })
    }
  }
  return out
}
