import { patchSubBoxDisplay } from './sheetDoc'
import { PATCH_FIELDS, patchKey, type SheetAct, type SheetSnapshot } from './types'

/**
 * Find-in-sheet.
 *
 * The house input column was not searched. It is the sheet's spine — what is
 * on channel 12 all day, whoever is playing — so "find KICK IN" found every
 * act's mic and DI cells and not the one row that says what channel 1 is,
 * which is the row somebody typing that query is usually looking for. It is
 * also the only column with the same value for every act, so its absence is
 * least visible and most annoying: the search looks like it worked.
 */

/** A grid cell's id: how the view finds the input to focus. */
export const cellId = (actId: string, channelId: string, field: string): string =>
  `${actId}:${channelId}:${field}`

/**
 * A channel row's two boxes, under the same scheme so the "next match" walk
 * can step through them like any other cell.
 */
export const channelCellId = (channelId: string, part: 'label' | 'input'): string =>
  `channel:${channelId}:${part}`

export interface SheetMatches {
  /** Patch cells whose text matches. */
  cells: Set<string>
  /** Channels whose number or name matches. */
  channels: Set<string>
  /** Channels whose house input matches. */
  inputs: Set<string>
  /** Every match in grid order, for the "next match" button. */
  order: string[]
}

const EMPTY: SheetMatches = { cells: new Set(), channels: new Set(), inputs: new Set(), order: [] }

/** Everything on the sheet whose display value contains the query. */
export function findMatches(
  snapshot: SheetSnapshot,
  acts: SheetAct[],
  query: string
): SheetMatches {
  const q = query.trim().toLowerCase()
  if (!q) return EMPTY

  const cells = new Set<string>()
  const channels = new Set<string>()
  const inputs = new Set<string>()
  const order: string[] = []

  for (const channel of snapshot.channels) {
    // The spine first, so a row's own two boxes come before the acts across
    // it — which is the order somebody reads the row in.
    if (channel.label.toLowerCase().includes(q)) {
      channels.add(channel.id)
      order.push(channelCellId(channel.id, 'label'))
    }
    if (channel.input.toLowerCase().includes(q)) {
      inputs.add(channel.id)
      order.push(channelCellId(channel.id, 'input'))
    }
    for (const act of acts) {
      const entry = snapshot.patches[patchKey(act.id, channel.id)]
      if (!entry) continue
      for (const field of PATCH_FIELDS) {
        const display =
          field === 'subBox' ? patchSubBoxDisplay(entry, snapshot.subBoxes) : entry[field]
        if (display && display.toLowerCase().includes(q)) {
          const id = cellId(act.id, channel.id, field)
          cells.add(id)
          order.push(id)
        }
      }
    }
  }
  return { cells, channels, inputs, order }
}
