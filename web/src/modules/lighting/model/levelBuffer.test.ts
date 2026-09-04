import { describe, expect, it } from 'vitest'
import { LevelBuffer } from './levelBuffer.ts'

/**
 * Folding live DMX between paints.
 *
 * Four frames a second per watched universe, each of which used to copy the
 * whole levels Map and rebuild the plot's SVG scene. The rig does not change
 * faster than the screen redraws, so the only thing that was buying was heat
 * in somebody's pocket.
 */

const frame = (universe: number, full: boolean, values: Array<[number, number]>) => ({
  universe,
  full,
  values,
})

describe('folding level frames', () => {
  it('publishes nothing until something arrives', () => {
    const buffer = new LevelBuffer()
    expect(buffer.pending).toBe(false)
    expect(buffer.take()).toBeNull()
  })

  it('collapses a burst into one publish at the latest value', () => {
    // The whole point. A channel that went 0 → 128 → 255 between two paints
    // is drawn once, at 255.
    const buffer = new LevelBuffer()
    buffer.add(frame(1, true, [[1, 0]]))
    buffer.add(frame(1, false, [[1, 128]]))
    buffer.add(frame(1, false, [[1, 255]]))

    const levels = buffer.take()
    expect(levels?.get(1)?.[0]).toBe(255)
    // And one publish, not three.
    expect(buffer.take()).toBeNull()
  })

  it('keeps universes apart', () => {
    const buffer = new LevelBuffer()
    buffer.add(frame(1, true, [[1, 10]]))
    buffer.add(frame(2, true, [[1, 20]]))
    const levels = buffer.take()!
    expect(levels.get(1)?.[0]).toBe(10)
    expect(levels.get(2)?.[0]).toBe(20)
  })

  it('treats a change list as a change and a full frame as a replacement', () => {
    const buffer = new LevelBuffer()
    buffer.add(
      frame(1, true, [
        [1, 255],
        [2, 128],
      ])
    )
    buffer.take()
    // A change list leaves everything it does not mention alone — that is
    // what makes the box able to send only what moved.
    buffer.add(frame(1, false, [[2, 0]]))
    let levels = buffer.take()!
    expect([levels.get(1)?.[0], levels.get(1)?.[1]]).toEqual([255, 0])

    // A full frame is the snapshot a client gets on its first look, so
    // anything it does not mention is off.
    buffer.add(frame(1, true, [[3, 64]]))
    levels = buffer.take()!
    expect([levels.get(1)?.[0], levels.get(1)?.[2]]).toEqual([0, 64])
  })

  it('hands out a fresh Map and fresh arrays every time', () => {
    // The store's consumers compare by identity — `useLiveLook` is memoised
    // on the Map — so handing back the staging copies would both fail to
    // re-render and let the next frame mutate what React is holding.
    const buffer = new LevelBuffer()
    buffer.add(frame(1, true, [[1, 100]]))
    const first = buffer.take()!
    buffer.add(frame(1, false, [[1, 200]]))
    const second = buffer.take()!
    expect(second).not.toBe(first)
    expect(second.get(1)).not.toBe(first.get(1))
    expect(first.get(1)?.[0]).toBe(100)
    expect(second.get(1)?.[0]).toBe(200)
  })

  it('ignores an address outside the universe rather than writing past it', () => {
    const buffer = new LevelBuffer()
    buffer.add(
      frame(1, true, [
        [0, 99],
        [513, 99],
        [1, 7],
      ])
    )
    const slots = buffer.take()!.get(1)!
    expect(slots.length).toBe(512)
    expect(slots[0]).toBe(7)
    expect(slots.some((v, i) => i !== 0 && v !== 0)).toBe(false)
  })

  it('forgets everything on clear, so a reconnect starts from the new snapshot', () => {
    // The box sends a full frame per universe on a fresh subscription. Folding
    // it onto the old staging would leave a channel that has since gone out
    // showing its last value until something else moved it.
    const buffer = new LevelBuffer()
    buffer.add(frame(1, true, [[1, 255]]))
    buffer.clear()
    expect(buffer.pending).toBe(false)
    expect(buffer.take()).toBeNull()
    buffer.add(frame(1, true, [[2, 5]]))
    const slots = buffer.take()!.get(1)!
    expect(slots[0]).toBe(0)
    expect(slots[1]).toBe(5)
  })
})
