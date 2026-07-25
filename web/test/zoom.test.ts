import { describe, expect, it } from 'vitest'
import { panBy, zoomAt, zoomIdentity, ZOOM_MAX } from '../src/lib/zoom.ts'

const W = 400
const H = 300

describe('zoomAt', () => {
  it('keeps the focal point fixed on screen', () => {
    // Zoom 2x around (100, 50): that base point must stay at the same
    // screen position: screen = t + s·q where q = (f - t)/s.
    const s1 = zoomAt(zoomIdentity, 100, 50, 2, W, H)
    expect(s1.scale).toBe(2)
    // Before: point q=(100,50) at screen (100,50). After: t + 2q must equal (100,50).
    expect(s1.tx + 2 * 100).toBeCloseTo(100)
    expect(s1.ty + 2 * 50).toBeCloseTo(50)
  })

  it('clamps at the maximum and back to identity at 1', () => {
    let s = zoomIdentity
    for (let i = 0; i < 10; i++) s = zoomAt(s, 200, 150, 2, W, H)
    expect(s.scale).toBe(ZOOM_MAX)
    const back = zoomAt(s, 200, 150, 0.01, W, H)
    expect(back).toEqual(zoomIdentity) // scale clamps to 1 and pan resets
  })

  it('never exposes a gap at the edges', () => {
    // Zooming around the very corner pushes the image against that edge.
    const s = zoomAt(zoomIdentity, 0, 0, 3, W, H)
    expect(s.tx).toBe(0)
    expect(s.ty).toBe(0)
    const s2 = zoomAt(zoomIdentity, W, H, 3, W, H)
    expect(s2.tx).toBe(W - W * 3)
    expect(s2.ty).toBe(H - H * 3)
  })
})

describe('panBy', () => {
  it('pans within bounds and clamps at the edges', () => {
    const zoomed = zoomAt(zoomIdentity, W / 2, H / 2, 2, W, H)
    const panned = panBy(zoomed, 50, -30, W, H)
    expect(panned.tx).toBe(zoomed.tx + 50)
    expect(panned.ty).toBe(zoomed.ty - 30)
    // Push far past the edge: clamps to [w - w·s, 0].
    const hard = panBy(zoomed, 10_000, -10_000, W, H)
    expect(hard.tx).toBe(0)
    expect(hard.ty).toBe(H - H * 2)
  })

  it('cannot pan at scale 1', () => {
    expect(panBy(zoomIdentity, 40, 40, W, H)).toEqual(zoomIdentity)
  })
})
