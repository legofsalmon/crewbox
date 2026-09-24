// @vitest-environment happy-dom
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePanZoom } from './usePanZoom.ts'

/**
 * The finger handling behind the plan and the front elevation, on a drawing
 * whose geometry is set by hand: happy-dom lays nothing out. The browser end
 * of it (touches becoming pointer events, `touch-action`, the click a tap
 * makes) is in e2e/touch.spec.ts; this is the bookkeeping between fingers.
 */

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

/** The box: 200 x 150 at (10, 20). The drawing: 400 x 300 at zoom 1. */
const BOX = { left: 10, top: 20, width: 200, height: 150 }
const DRAWING = { width: 400, height: 300 }

let root: Root
let host: HTMLElement
let paused = false
let picked = 0
let frames: FrameRequestCallback[] = []

function Pad() {
  const svg = useRef<SVGSVGElement>(null)
  const { zoom, step, boxProps } = usePanZoom(svg, paused)
  return (
    <div className="page" style={{ overflowY: 'auto' }}>
      <output>{zoom}</output>
      <button type="button" onClick={() => step(0.2)}>
        in
      </button>
      <div className="box" {...boxProps}>
        <svg ref={svg} width={DRAWING.width * zoom} height={DRAWING.height * zoom}>
          <circle className="dot" onClick={() => picked++} />
        </svg>
      </div>
    </div>
  )
}

const box = () => host.querySelector<HTMLDivElement>('.box')!
const page = () => host.querySelector<HTMLDivElement>('.page')!
const zoom = () => Number(host.querySelector('output')!.textContent)
const dot = () => host.querySelector('.dot')!

/** Lay the box and drawing out as a browser would, scrolling clamped. */
function layOut() {
  const el = box()
  const svg = el.querySelector('svg')!
  const scroll = { left: 0, top: 0 }
  const size = () => ({
    width: Number(svg.getAttribute('width')),
    height: Number(svg.getAttribute('height')),
  })
  const clamp = (value: number, max: number) => Math.min(Math.max(0, value), Math.max(0, max))
  Object.defineProperties(el, {
    clientWidth: { get: () => BOX.width },
    clientHeight: { get: () => BOX.height },
    clientLeft: { get: () => 0 },
    clientTop: { get: () => 0 },
    scrollLeft: {
      get: () => scroll.left,
      set: (v: number) => (scroll.left = clamp(v, size().width - BOX.width)),
    },
    scrollTop: {
      get: () => scroll.top,
      set: (v: number) => (scroll.top = clamp(v, size().height - BOX.height)),
    },
  })
  el.getBoundingClientRect = () => DOMRect.fromRect({ x: BOX.left, y: BOX.top, ...BOX })
  svg.getBoundingClientRect = () =>
    DOMRect.fromRect({
      x: BOX.left - scroll.left,
      y: BOX.top - scroll.top,
      ...size(),
    })
}

const pointer = (
  type: string,
  id: number,
  x: number,
  y: number,
  target: Element = box(),
  pointerType = 'touch'
) =>
  act(() => {
    target.dispatchEvent(
      new PointerEvent(type, { bubbles: true, pointerId: id, pointerType, clientX: x, clientY: y })
    )
  })

/** Run the frame a pinch asked for. */
const nextFrame = () =>
  act(() => {
    for (const frame of frames.splice(0)) frame(0)
  })

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  paused = false
  picked = 0
  frames = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((frame) => frames.push(frame))
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  document.body.innerHTML = ''
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(<Pad />))
  layOut()
})

afterEach(() => {
  act(() => root.unmount())
  vi.restoreAllMocks()
})

describe('fingers on a drawing', () => {
  it('pans with one finger once it has moved further than a tap', () => {
    pointer('pointerdown', 1, 100, 100)
    pointer('pointermove', 1, 95, 97)
    expect(box().scrollLeft).toBe(0)
    // Past the slop: from here on the drawing follows the finger.
    pointer('pointermove', 1, 90, 90)
    pointer('pointermove', 1, 40, 60)
    pointer('pointerup', 1, 40, 60)
    expect([box().scrollLeft, box().scrollTop]).toEqual([50, 30])
  })

  it('pinches about the point between the fingers', () => {
    pointer('pointerdown', 1, 60, 80)
    pointer('pointerdown', 2, 100, 80)
    // Between them is (80, 80): the drawing's point (70, 60).
    pointer('pointermove', 2, 140, 80)
    pointer('pointermove', 1, 20, 80)
    nextFrame()
    expect(zoom()).toBe(3)
    expect(box().scrollLeft).toBe(70 * 3 - 70)
    expect(box().scrollTop).toBe(60 * 3 - 60)
  })

  it('keeps the zoom between 40% and 300%', () => {
    pointer('pointerdown', 1, 60, 80)
    pointer('pointerdown', 2, 160, 80)
    pointer('pointermove', 2, 70, 80)
    nextFrame()
    expect(zoom()).toBe(0.4)
    pointer('pointermove', 2, 1000, 80)
    nextFrame()
    expect(zoom()).toBe(3)
  })

  it('draws a pinch once a frame, however many moves it had', () => {
    pointer('pointerdown', 1, 60, 80)
    pointer('pointerdown', 2, 100, 80)
    pointer('pointermove', 2, 110, 80)
    pointer('pointermove', 2, 120, 80)
    pointer('pointermove', 2, 140, 80)
    expect(frames).toHaveLength(1)
    expect(zoom()).toBe(1)
    nextFrame()
    expect(zoom()).toBe(2)
  })

  it('carries on panning with the finger left when one of two lifts', () => {
    pointer('pointerdown', 1, 60, 80)
    pointer('pointerdown', 2, 100, 80)
    pointer('pointermove', 2, 140, 80)
    nextFrame()
    const [left, top] = [box().scrollLeft, box().scrollTop]
    pointer('pointerup', 1, 60, 80)
    pointer('pointermove', 2, 120, 70)
    expect([box().scrollLeft, box().scrollTop]).toEqual([left + 20, top + 10])
  })

  it('ignores a third finger', () => {
    pointer('pointerdown', 1, 60, 80)
    pointer('pointerdown', 2, 100, 80)
    pointer('pointerdown', 3, 150, 150)
    pointer('pointermove', 3, 400, 400)
    nextFrame()
    expect(zoom()).toBe(1)
    pointer('pointermove', 2, 140, 80)
    nextFrame()
    expect(zoom()).toBe(2)
  })

  it('hands the page what the box cannot scroll', () => {
    const scrollBy = vi.fn()
    Object.defineProperties(page(), {
      scrollHeight: { get: () => 2000 },
      clientHeight: { get: () => 800 },
    })
    page().scrollBy = scrollBy as typeof Element.prototype.scrollBy
    pointer('pointerdown', 1, 100, 160)
    pointer('pointermove', 1, 100, 150)
    // The box has 150 to give downward, the page the other 50.
    pointer('pointermove', 1, 100, -50)
    expect(box().scrollTop).toBe(150)
    expect(scrollBy).toHaveBeenCalledWith(0, 50)
  })

  it('leaves the mouse to the scrollbars', () => {
    pointer('pointerdown', 1, 100, 100, box(), 'mouse')
    pointer('pointermove', 1, 90, 90, box(), 'mouse')
    pointer('pointermove', 1, 20, 20, box(), 'mouse')
    expect([box().scrollLeft, box().scrollTop]).toEqual([0, 0])
  })

  it('leaves fingers alone while something else has them', () => {
    paused = true
    act(() => root.render(<Pad />))
    pointer('pointerdown', 1, 100, 100)
    pointer('pointermove', 1, 90, 90)
    pointer('pointermove', 1, 20, 20)
    expect([box().scrollLeft, box().scrollTop]).toEqual([0, 0])
  })

  describe('a fixture under the finger', () => {
    const click = () =>
      act(() => {
        dot().dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
    const touch = (moves: Array<[number, number]>) => {
      pointer('pointerdown', 1, 100, 100, dot())
      for (const [x, y] of moves) pointer('pointermove', 1, x, y, dot())
      const [x, y] = moves.at(-1) ?? [100, 100]
      pointer('pointerup', 1, x, y, dot())
    }

    it('is picked by a tap, wobble and all', () => {
      touch([[102, 101]])
      click()
      expect(picked).toBe(1)
    })

    it('is not picked by the click a browser makes of a short pan', () => {
      // 12 pixels: a pan here, and still a tap to Chromium, whose slop is 15.
      touch([[88, 100]])
      click()
      expect(picked).toBe(0)
    })

    it('is picked by the next tap after a pan that made no click', () => {
      // A long pan: the browser makes no click, so nothing uses up the
      // swallow, and the next touch has to clear it.
      touch([
        [80, 100],
        [20, 100],
      ])
      touch([])
      click()
      expect(picked).toBe(1)
    })
  })

  it('zooms from a button about the middle of the box', () => {
    // The middle of the box, (110, 95), is the drawing's (100, 75).
    act(() => host.querySelector('button')!.click())
    expect(zoom()).toBe(1.2)
    expect(box().scrollLeft).toBeCloseTo(100 * 1.2 - 100)
    expect(box().scrollTop).toBeCloseTo(75 * 1.2 - 75)
  })
})
