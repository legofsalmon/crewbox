import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
} from 'react'
import { flushSync } from 'react-dom'

/**
 * Fingers on the plan and the front elevation: one pans, two pinch.
 *
 * Both drawings sit in a scrolling box with `touch-action: none`, which the
 * plan's position drag needs: without it a browser takes a finger on a truss
 * for the start of a scroll and cancels the drag. It also meant a finger
 * could not move a drawing at all, and in the apps, which don't let the page
 * be pinched, nothing could be made bigger than the buttons allow. On a
 * phone, anything past the first screenful of a rig was out of reach. This
 * does by hand what the browser was told not to:
 *
 *  - A finger that moves further than a tap would scrolls the box, and what
 *    the box cannot take goes to the page around it, as a scroll does.
 *  - Two fingers zoom by the change in the distance between them, and the
 *    point of the drawing between them stays between them, so what is being
 *    pinched is what grows. Moving both pans at the same time.
 *  - A tap still selects a fixture. A touch that became a pan or a pinch
 *    selects nothing, even where it began on one.
 *
 * A mouse is left alone: it has the scrollbars, the wheel and the buttons.
 * The buttons zoom about the middle of the box, so what is in view stays in
 * view; they used to zoom about the drawing's top left corner.
 */

export const MIN_ZOOM = 0.4
export const MAX_ZOOM = 3

/**
 * How far a finger moves before it is panning, in CSS pixels. Android's own
 * touch slop is 8dp, and a CSS pixel is about a dp on a phone.
 */
const SLOP = 8

interface Point {
  x: number
  y: number
}

/** What a touch has become so far. */
type Gesture =
  /** One finger, not yet moved further than a tap would. */
  | { kind: 'press'; id: number; start: Point }
  | { kind: 'pan'; id: number; last: Point }
  /** `anchor` is the point of the drawing that started between the fingers, at zoom 1. */
  | { kind: 'pinch'; ids: [number, number]; distance: number; zoom: number; anchor: Point }

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))

/** The nearest ancestor that scrolls vertically, for a pan to hand on to. */
function verticalScroller(from: HTMLElement | null): Element | null {
  for (let el = from; el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el)
    if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
      return el
    }
  }
  return document.scrollingElement
}

export interface PanZoom {
  zoom: number
  /** Zoom by a button's step, about the middle of what is in view. */
  step: (by: number) => void
  /** True while fingers are panning or pinching. */
  busy: () => boolean
  /** Spread onto the scrolling box around the drawing. */
  boxProps: {
    ref: RefObject<HTMLDivElement | null>
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => void
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => void
    onPointerUp: (e: PointerEvent<HTMLDivElement>) => void
    onPointerCancel: (e: PointerEvent<HTMLDivElement>) => void
    onClickCapture: (e: MouseEvent<HTMLDivElement>) => void
  }
}

/**
 * @param drawing The drawing inside the box, for where its points are.
 * @param paused  True while something else owns the fingers (a position
 *   being dragged); a finger that lands then is left alone.
 */
export function usePanZoom(drawing: RefObject<SVGSVGElement | null>, paused = false): PanZoom {
  const [zoom, setZoom] = useState(1)
  const box = useRef<HTMLDivElement>(null)
  /** The zoom the drawing is on screen at, read between renders mid-gesture. */
  const shown = useRef(1)
  /** Every finger this gesture is following, where it last was. */
  const fingers = useRef(new Map<number, Point>())
  const gesture = useRef<Gesture | null>(null)
  /** Set once a touch pans or pinches, so a click it ends with selects nothing. */
  const swallowClick = useRef(false)
  const frame = useRef(0)
  const nextPinch = useRef<{ zoom: number; anchor: Point; at: Point } | null>(null)

  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  // A drawing wider than its box opens at its middle, the middle of the
  // stage, where centring it used to put it; now the edges can be scrolled
  // to as well. Before the first paint, so it never shows at its left edge.
  useLayoutEffect(() => {
    const el = box.current
    if (el) el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2
  }, [])

  /** The point of the drawing under a point on screen, in pixels at zoom 1. */
  const drawingPoint = (at: Point): Point | null => {
    const rect = drawing.current?.getBoundingClientRect()
    if (!rect) return null
    return { x: (at.x - rect.left) / shown.current, y: (at.y - rect.top) / shown.current }
  }

  /**
   * Scroll the box. A pan hands on what the box could not take, so a finger
   * on a drawing that already fits still scrolls the page past it.
   */
  const scrollBy = (dx: number, dy: number, chain: boolean) => {
    const el = box.current
    if (!el) return
    const top = el.scrollTop
    el.scrollLeft += dx
    el.scrollTop += dy
    const rest = dy - (el.scrollTop - top)
    if (chain && Math.abs(rest) >= 1) verticalScroller(el.parentElement)?.scrollBy(0, rest)
  }

  /** Draw at `next`, scrolled so that `anchor`, a point of the drawing, is at `at`. */
  const zoomAbout = (next: number, anchor: Point, at: Point) => {
    const target = clampZoom(next)
    if (target !== shown.current) {
      // Now rather than at React's convenience, so the scroll below is
      // worked out against the drawing at its new size, and both reach the
      // screen in the same frame.
      flushSync(() => setZoom(target))
      shown.current = target
    }
    const rect = drawing.current?.getBoundingClientRect()
    if (!rect) return
    scrollBy(rect.left + anchor.x * target - at.x, rect.top + anchor.y * target - at.y, false)
  }

  const step = (by: number) => {
    const el = box.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const at = {
      x: rect.left + el.clientLeft + el.clientWidth / 2,
      y: rect.top + el.clientTop + el.clientHeight / 2,
    }
    const anchor = drawingPoint(at)
    if (anchor) zoomAbout(Math.round((shown.current + by) * 10) / 10, anchor, at)
  }

  /** A pinch follows every move, but draws at most once a frame. */
  const queuePinch = (next: number, anchor: Point, at: Point) => {
    nextPinch.current = { zoom: next, anchor, at }
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const job = nextPinch.current
      nextPinch.current = null
      if (job) zoomAbout(job.zoom, job.anchor, job.at)
    })
  }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const current = gesture.current
    if (!current) swallowClick.current = false
    if (e.pointerType === 'mouse' || paused) return
    const at = { x: e.clientX, y: e.clientY }
    if (!current) {
      fingers.current.set(e.pointerId, at)
      gesture.current = { kind: 'press', id: e.pointerId, start: at }
      return
    }
    if (current.kind === 'pinch') return // a third finger changes nothing
    const first = fingers.current.get(current.id)
    const anchor = first && drawingPoint(midpoint(first, at))
    if (!first || !anchor) return
    fingers.current.set(e.pointerId, at)
    swallowClick.current = true
    gesture.current = {
      kind: 'pinch',
      ids: [current.id, e.pointerId],
      distance: Math.max(1, distance(first, at)),
      zoom: shown.current,
      anchor,
    }
  }

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const current = gesture.current
    if (!current || !fingers.current.has(e.pointerId)) return
    const at = { x: e.clientX, y: e.clientY }
    fingers.current.set(e.pointerId, at)
    if (current.kind === 'press') {
      // From here, not from where the finger landed: the first few pixels
      // were a tap's, and taking them now would make the drawing jump.
      if (distance(at, current.start) < SLOP) return
      swallowClick.current = true
      gesture.current = { kind: 'pan', id: current.id, last: at }
    } else if (current.kind === 'pan') {
      scrollBy(current.last.x - at.x, current.last.y - at.y, true)
      current.last = at
    } else {
      const a = fingers.current.get(current.ids[0])
      const b = fingers.current.get(current.ids[1])
      if (!a || !b) return
      queuePinch(current.zoom * (distance(a, b) / current.distance), current.anchor, midpoint(a, b))
    }
  }

  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    if (!fingers.current.delete(e.pointerId)) return
    const current = gesture.current
    if (current?.kind === 'pinch') {
      // One finger lifted: the other carries on panning from where it is.
      const other = current.ids.find((id) => id !== e.pointerId)
      const at = other === undefined ? undefined : fingers.current.get(other)
      gesture.current = other !== undefined && at ? { kind: 'pan', id: other, last: at } : null
    } else {
      gesture.current = null
    }
  }

  const onClickCapture = (e: MouseEvent<HTMLDivElement>) => {
    if (!swallowClick.current) return
    swallowClick.current = false
    e.stopPropagation()
    e.preventDefault()
  }

  return {
    zoom,
    step,
    busy: () => gesture.current !== null,
    boxProps: {
      ref: box,
      onPointerDown,
      onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel: onPointerEnd,
      onClickCapture,
    },
  }
}
