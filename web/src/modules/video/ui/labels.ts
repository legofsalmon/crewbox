import type { Box } from '../model/screenSetup.ts'

/**
 * Greedy label placement: push each rect down until it no longer overlaps
 * an earlier one. Rects are mutated in place, in the order given, so the
 * caller decides who keeps their spot (bigger slices first, so the labels
 * of the small ones nested inside them move).
 */
export function resolveOverlaps(rects: Box[], gap = 2): void {
  const placed: Box[] = []
  for (const r of rects) {
    for (let guard = 0; guard < 300; guard++) {
      const hit = placed.find(
        (q) =>
          r.x < q.x + q.w + gap &&
          r.x + r.w + gap > q.x &&
          r.y < q.y + q.h + gap &&
          r.y + r.h + gap > q.y
      )
      if (!hit) break
      r.y = hit.y + hit.h + gap
    }
    placed.push(r)
  }
}
