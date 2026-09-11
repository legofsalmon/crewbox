import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { unionBox, type Box, type Pt } from '../model/screenSetup.ts'
import { resolveOverlaps } from './labels.ts'
import styles from './ScreenMap.module.scss'

/**
 * One map: a bounded area (the composition, or a screen) with slices drawn
 * on it. Pan by dragging, zoom with ⌘/Ctrl + wheel or the buttons, tap a
 * slice to pin it. Labels sit at each slice's top-left and are pushed apart
 * where slices stack, and drop to the name alone — or nothing — as the
 * slice gets small on screen, so a 200-tile LED map reads as a grid of
 * numbers rather than a smear of text.
 *
 * Plain wheel scrolls the page: a pane full of maps must not eat every
 * scroll gesture that crosses one.
 */

export interface MapItem {
  id: string
  poly: Pt[]
  /**
   * The polygon's bounding box and area, carried rather than derived.
   *
   * `bboxOf` walks the whole polygon, and on a 200-slice map every consumer
   * wanted one: this component's `shapes`, `worldBox` and `labels` memos, and
   * the caller's own row sort — which was calling it twice per comparison.
   * They are computed once on `SliceView` (see `screenSetup.ts`) and passed
   * through here.
   */
  bb: Box
  area: number
  name: string
  sub: string
  color: string
  hue: number
  active: boolean
  mask: boolean
}

interface Props {
  bounds: Box
  items: MapItem[]
  hoverId: string | null
  selectedId: string | null
  onHover: (id: string | null) => void
  onSelect: (id: string | null) => void
  /** Rows and columns of the pinned slice's warp mesh, when it has been edited. */
  mesh?: Pt[][] | null
  label: string
}

interface View {
  s: number
  tx: number
  ty: number
  fit: number
}

const MARGIN = 16

const fitView = (W: number, H: number, box: Box): View => {
  const s = Math.min((W - 2 * MARGIN) / box.w, (H - 2 * MARGIN) / box.h)
  return { s, fit: s, tx: (W - box.w * s) / 2 - box.x * s, ty: (H - box.h * s) / 2 - box.y * s }
}

const hitId = (target: EventTarget | null): string | null => {
  if (!(target instanceof Element)) return null
  const el = target.closest('[data-id]')
  return el instanceof SVGElement || el instanceof HTMLElement ? (el.dataset.id ?? null) : null
}

export default function ScreenMap({
  bounds,
  items,
  hoverId,
  selectedId,
  onHover,
  onSelect,
  mesh = null,
  label,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const sizeRef = useRef({ W: 0, H: 0 })
  const [size, setSize] = useState({ W: 0, H: 0 })
  const [view, setView] = useState<View>({ s: 1, tx: 0, ty: 0, fit: 1 })
  const drag = useRef<{
    x: number
    y: number
    tx: number
    ty: number
    moved: boolean
    hit: string | null
  } | null>(null)

  const worldBox = useMemo(() => {
    let box: Box = { ...bounds }
    for (const it of items) box = unionBox(box, it.bb)
    return box
  }, [bounds, items])

  const shapes = useMemo(
    () =>
      items.map((it) => ({
        it,
        bb: it.bb,
        points: it.poly.map((p) => `${p.x},${p.y}`).join(' '),
      })),
    [items]
  )

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (!r) return
      sizeRef.current = { W: r.width, H: r.height }
      // Only when it really changed. `setSize` with a fresh object every
      // callback made the fit effect below a dependency of its own identity,
      // and ResizeObserver fires on plenty of non-changes.
      setSize((prev) =>
        prev.W === r.width && prev.H === r.height ? prev : { W: r.width, H: r.height }
      )
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /**
   * Auto-fit, but never over the top of somebody's own zoom.
   *
   * A crew member who has zoomed into one tile of a 200-tile map to read its
   * coordinates loses that view on any resize — toggling the drawer, turning
   * the phone, dragging a desktop window. `view.s === view.fit` is the test
   * for "still where we put it", and the Fit button is how they ask for this
   * on purpose.
   */
  useEffect(() => {
    if (size.W <= 0 || size.H <= 0 || worldBox.w <= 0 || worldBox.h <= 0) return
    setView((v) => (v.s === v.fit ? fitView(size.W, size.H, worldBox) : v))
  }, [size, worldBox])

  const fit = useCallback(() => {
    const { W, H } = sizeRef.current
    if (W > 0 && H > 0 && worldBox.w > 0 && worldBox.h > 0) setView(fitView(W, H, worldBox))
  }, [worldBox])

  const zoomBy = useCallback((k: number, mx?: number, my?: number) => {
    const { W, H } = sizeRef.current
    const cx = mx ?? W / 2
    const cy = my ?? H / 2
    setView((v) => {
      const ns = Math.min(Math.max(v.s * k, v.fit * 0.2), v.fit * 400)
      const kk = ns / v.s
      return { ...v, s: ns, tx: cx - (cx - v.tx) * kk, ty: cy - (cy - v.ty) * kk }
    })
  }, [])

  // React registers wheel listeners as passive, so a zoom that must stop the
  // page scrolling has to be attached by hand.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const r = svg.getBoundingClientRect()
      const delta = Math.min(Math.max(e.deltaY, -50), 50)
      zoomBy(Math.exp(-delta * 0.01), e.clientX - r.left, e.clientY - r.top)
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [zoomBy])

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return
    drag.current = {
      x: e.clientX,
      y: e.clientY,
      tx: view.tx,
      ty: view.ty,
      moved: false,
      hit: hitId(e.target),
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (!d.moved && Math.hypot(dx, dy) < 3) return
    d.moved = true
    setView((v) => ({ ...v, tx: d.tx + dx, ty: d.ty + dy }))
  }
  const onPointerUp = () => {
    const d = drag.current
    drag.current = null
    if (!d || d.moved) return
    onSelect(d.hit && d.hit !== selectedId ? d.hit : null)
  }

  /**
   * Label geometry, and deliberately *not* a function of what is focused.
   *
   * `resolveOverlaps` is O(n²) in the labels it places, and this used to
   * depend on `hoverId` and `selectedId` as well as `view` — so moving a
   * pointer across a 215-slice map re-laid out every label in every map on
   * the page, once per polygon entered, and a drag did the same on every
   * frame. Hover and selection change which labels are *shown*, never where
   * they sit, so they belong to the cheap pass below instead.
   */
  const placed = useMemo(() => {
    const rects: Box[] = []
    const out: { it: MapItem; rect: Box; fitsName: boolean; fitsSub: boolean }[] = []
    for (const { it, bb } of shapes) {
      const needName = it.name.length * 6.5 + 10
      const needSub = it.sub.length * 5 + 10
      const pw = bb.w * view.s
      const ph = bb.h * view.s
      const fitsName = pw >= needName && ph >= 16
      const fitsSub = fitsName && pw >= needSub && ph >= 28
      const rect = {
        x: bb.x * view.s + view.tx + 5,
        y: bb.y * view.s + view.ty + 3,
        w: fitsSub ? Math.max(needName, needSub) : needName,
        h: fitsSub ? 24 : 13,
      }
      if (fitsName) rects.push(rect)
      out.push({ it, rect, fitsName, fitsSub })
    }
    resolveOverlaps(rects)
    return out
  }, [shapes, view])

  // A focused slice shows its label whether or not it fitted. One pass, no
  // geometry: this is what re-runs on hover.
  const labels = useMemo(
    () =>
      placed.map(({ it, rect, fitsName, fitsSub }) => {
        const focus = it.id === hoverId || it.id === selectedId
        return { it, rect, show: fitsName || focus, sub: fitsSub || focus }
      }),
    [placed, hoverId, selectedId]
  )

  // Two hundred stacked full-screen slices at a third opacity each is a
  // solid block; thin the fill as the count grows.
  const fill = items.length > 20 ? Math.max(0.04, (0.32 * 20) / items.length) : 0.32

  return (
    <div ref={wrapRef} className={styles.wrap}>
      <svg
        ref={svgRef}
        className={`${styles.map} ${view.s > view.fit * 1.01 ? styles.engaged : ''}`}
        role="img"
        aria-label={label}
        style={{ '--fill': fill.toFixed(3) } as CSSProperties}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          drag.current = null
        }}
      >
        <g transform={`translate(${view.tx} ${view.ty}) scale(${view.s})`}>
          <rect
            className={styles.bounds}
            x={bounds.x}
            y={bounds.y}
            width={bounds.w}
            height={bounds.h}
            vectorEffect="non-scaling-stroke"
          />
          {shapes.map(({ it, points }) => (
            <polygon
              key={it.id}
              data-id={it.id}
              points={points}
              fill={it.color}
              stroke={it.color}
              vectorEffect="non-scaling-stroke"
              className={[
                styles.shape,
                it.active ? '' : styles.disabled,
                it.mask ? styles.mask : '',
                it.id === hoverId ? styles.hover : '',
                it.id === selectedId ? styles.selected : '',
              ].join(' ')}
              onPointerEnter={() => onHover(it.id)}
              onPointerLeave={() => onHover(null)}
            />
          ))}
          {mesh?.map((line, i) => (
            <polyline
              key={i}
              className={styles.mesh}
              points={line.map((p) => `${p.x},${p.y}`).join(' ')}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </g>
        <g className={styles.labels}>
          {labels.map(
            ({ it, rect, show, sub }) =>
              show && (
                <g key={it.id} transform={`translate(${rect.x} ${rect.y + 10})`}>
                  <text className={styles.name}>{it.name}</text>
                  {sub && (
                    <text className={styles.sub} y={12}>
                      {it.sub}
                    </text>
                  )}
                </g>
              )
          )}
        </g>
      </svg>
      <div className={styles.tools}>
        <button
          type="button"
          aria-label="Zoom out"
          title="Zoom out"
          onClick={() => zoomBy(1 / 1.5)}
        >
          −
        </button>
        <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => zoomBy(1.5)}>
          +
        </button>
        <button type="button" aria-label="Fit" title="Fit (⌘/Ctrl + wheel zooms)" onClick={fit}>
          Fit
        </button>
      </div>
    </div>
  )
}
