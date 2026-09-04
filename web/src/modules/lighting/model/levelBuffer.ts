/**
 * Live DMX levels, folded together between paints.
 *
 * The box sends one `dmxLevels` message per watched universe per tick, four
 * times a second. Each one used to copy the whole levels Map, copy a
 * 512-byte array, and call the store's `set()` — so a plot watching six
 * universes did twenty-four store updates a second, and every one of them
 * rebuilt the SVG scene from scratch, because `useLiveLook` is keyed on the
 * Map's identity. On the phones this is actually used on, that is the
 * difference between a live rig view and a warm phone.
 *
 * Nothing about the data needs that. A level that changed twice between two
 * paints is worth drawing once, at its latest value. So frames fold into a
 * mutable staging Map as they arrive — no copies, no renders — and `take()`
 * hands out one new Map per paint, which is the only moment React needs a
 * new identity.
 */

/** One `dmxLevels` message, reduced to what folding needs. */
export interface LevelFrame {
  universe: number
  /** True when this is a whole-universe snapshot rather than a change list. */
  full: boolean
  /** [address, level] pairs. Addresses are 1-based, levels 0–255. */
  values: Array<[number, number]>
}

const UNIVERSE_SLOTS = 512

export class LevelBuffer {
  /** Mutated in place as frames arrive; never handed out. */
  private staged = new Map<number, Uint8Array>()
  private dirty = false

  /**
   * Fold a frame in.
   *
   * `full` replaces the universe — it is the snapshot a client gets on its
   * first look at one — and anything else is a change list, so the values
   * that were already there have to survive it.
   */
  add(frame: LevelFrame): void {
    const slots = frame.full
      ? new Uint8Array(UNIVERSE_SLOTS)
      : (this.staged.get(frame.universe) ?? new Uint8Array(UNIVERSE_SLOTS))
    for (const [address, level] of frame.values) {
      // 1-based on the wire, and a malformed frame must not write past the
      // universe or into the one before it.
      if (address >= 1 && address <= UNIVERSE_SLOTS) slots[address - 1] = level
    }
    this.staged.set(frame.universe, slots)
    this.dirty = true
  }

  /**
   * The Map to publish, or null when nothing has arrived since the last
   * take — so a paint with no new levels costs no render at all.
   *
   * A new Map, and new arrays inside it: the store's consumers compare by
   * identity, and handing back the staging copies would let the next frame
   * mutate what React is already holding.
   */
  take(): Map<number, Uint8Array> | null {
    if (!this.dirty) return null
    this.dirty = false
    const out = new Map<number, Uint8Array>()
    for (const [universe, slots] of this.staged) out.set(universe, new Uint8Array(slots))
    return out
  }

  /** Forget everything — a reconnect, or the plot no longer being watched. */
  clear(): void {
    this.staged.clear()
    this.dirty = false
  }

  /** Whether a frame has arrived that no `take()` has published yet. */
  get pending(): boolean {
    return this.dirty
  }
}
