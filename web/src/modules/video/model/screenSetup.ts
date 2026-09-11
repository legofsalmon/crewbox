/**
 * Resolume Arena Advanced Output presets, read into a plain model.
 *
 * Arena saves a screen setup as XML: `Presets/Advanced Output/<name>.xml`
 * for a saved preset (`<XmlState>` root) and `Preferences/AdvancedOutput.xml`
 * for whatever is on the outputs right now (`<ScreenSetup>` root, with every
 * default-valued parameter left out). Both are read here.
 *
 * Pure: DOMParser in, JSON-able objects out. Nothing in this file touches
 * Yjs, React or the network, so it is unit-testable on its own and the
 * result can be stored in a document as a value and rebuilt on any device.
 *
 * Only geometry, sources and the flags a crew member asks about are kept.
 * Colour, brightness and the per-slice edge blend are ignored on purpose:
 * this module says where content lands, not how it looks. Untouched warp
 * meshes are dropped for the same reason — sixteen vertices per slice that
 * say "nothing was moved" would multiply a 200-slice LED map's document by
 * ten, on every phone, over festival Wi-Fi.
 */

export interface Pt {
  x: number
  y: number
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** A slice's input or output rectangle, kept as Arena stores it: four corners. */
export interface Rect {
  /** Corners in Arena's order — top-left, top-right, bottom-right, bottom-left, rotated as placed. */
  pts: Pt[]
  /** Radians. */
  rot: number
  /** Edge lengths, so a rotated slice still reports its own width and height. */
  w: number
  h: number
  bbox: Box
  /** Masks carry a unit rectangle here rather than composition pixels. */
  normalized: boolean
}

export type SourceKind = 'composition' | 'group' | 'layer' | 'other'

export interface SliceSource {
  raw: string
  kind: SourceKind
  index?: number
  label: string
}

/** A warp mesh somebody has actually edited, or a Bézier one. */
export interface Warp {
  mode: string
  cols: number
  rows: number
  verts: Pt[]
}

export interface Contour {
  points: Pt[]
  segments: string
  closed: boolean
}

export interface SetupLayer {
  /** `Slice`, `Mask`, or whatever Arena calls a shape this reader has not met. */
  kind: string
  uniqueId: string | null
  name: string
  enabled: boolean
  source: SliceSource
  inputOpacity: boolean
  inputBypass: boolean
  softEdge: boolean
  flip: number
  isKey: boolean
  blackBg: boolean
  invert: boolean
  input: Rect | null
  output: Rect | null
  /** Present only when the mesh differs from a flat grid, or is Bézier. */
  warp: Warp | null
  /** "Linear 4×4" — always known, even when `warp` is dropped as untouched. */
  warpSummary: string | null
  /** Corner pin moved off the identity. */
  cornerPinEdited: boolean
  contour: Contour | null
}

export interface OutputDevice {
  tag: string
  /** `Virtual`, `Display`, or the tag's suffix for a kind this reader has not met. */
  type: string
  name: string
  deviceId: string
  w: number
  h: number
  fullscreen: boolean
}

export interface SetupScreen {
  uniqueId: string | null
  name: string
  enabled: boolean
  hidden: boolean
  device: OutputDevice | null
  layers: SetupLayer[]
}

export interface ScreenSetup {
  name: string
  /** "Resolume Arena 7.27.1", or "unknown version" for a stripped preferences file. */
  version: string
  format: 'preset' | 'preferences'
  comp: { w: number; h: number }
  screens: SetupScreen[]
}

// --- Small helpers ------------------------------------------------------------

const num = (v: string | null | undefined, fallback = 0): number => {
  const n = parseFloat(v ?? '')
  return Number.isFinite(n) ? n : fallback
}

const bool = (v: string | null | undefined): boolean => v === '1' || v === 'true'

// Compared in lower case: an XML document keeps the case Arena wrote, an HTML
// one upper-cases, and the DOM under test is not the DOM in the browser.
const tagOf = (el: Element): string => el.tagName.toLowerCase()

const child = (el: Element | null, name: string): Element | null => {
  if (!el) return null
  for (const c of Array.from(el.children)) if (tagOf(c) === name) return c
  return null
}

const childrenOf = (el: Element | null, name: string): Element[] =>
  el ? Array.from(el.children).filter((c) => tagOf(c) === name) : []

/**
 * `<Params name="group"><Param name="…" value="…"/></Params>` lookup with a
 * default. The preferences file omits any parameter still at its default,
 * so every read here has to say what the default is.
 */
function paramValue(el: Element, group: string, name: string, fallback: string): string {
  for (const p of Array.from(el.children)) {
    if (tagOf(p) !== 'params' || p.getAttribute('name') !== group) continue
    for (const q of Array.from(p.children)) {
      if (q.getAttribute('name') !== name) continue
      // An empty `value` is Arena saying the field was cleared, not saying
      // nothing — `getAttribute` returns `''` rather than null, so `??` kept
      // it and defeated every fallback below. That mattered most for `Name`:
      // an unnamed slice rendered blank rows and blank aria-labels, and
      // because feeds are keyed by screen name, two unnamed screens both
      // wrote to `feeds['']` and mapping one silently mapped the other.
      //
      // Arena writes the built-in default on the same element, so prefer
      // that over the caller's before giving up on it.
      const value = q.getAttribute('value')
      if (value !== null && value !== '') return value
      const dflt = q.getAttribute('default')
      if (dflt !== null && dflt !== '') return dflt
      return fallback
    }
  }
  return fallback
}

const pointsOf = (el: Element | null): Pt[] =>
  childrenOf(el, 'v').map((v) => ({ x: num(v.getAttribute('x')), y: num(v.getAttribute('y')) }))

export const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y)

export function bboxOf(pts: Pt[]): Box {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of pts) {
    if (p.x < x0) x0 = p.x
    if (p.y < y0) y0 = p.y
    if (p.x > x1) x1 = p.x
    if (p.y > y1) y1 = p.y
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

export function unionBox(a: Box | null, b: Box): Box {
  if (!a) return b
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}

export const outsideBox = (bb: Box, bounds: Box, tol = 0.5): boolean =>
  bb.x < bounds.x - tol ||
  bb.y < bounds.y - tol ||
  bb.x + bb.w > bounds.x + bounds.w + tol ||
  bb.y + bb.h > bounds.y + bounds.h + tol

/** Whole pixels where it is one, two decimals where it is not. */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return '–'
  const r = Math.round(n)
  if (Math.abs(n - r) < 0.01) return String(r)
  return n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}

export const degrees = (rad: number): number => Math.round(((rad * 180) / Math.PI) * 100) / 100

export function rectFromPts(pts: Pt[], rot: number): Rect | null {
  if (pts.length < 3) return null
  const [a, b, c] = pts as [Pt, Pt, Pt]
  const w = dist(a, b)
  const h = dist(b, c)
  return {
    pts,
    rot: rot || 0,
    w,
    h,
    bbox: bboxOf(pts),
    /**
     * Unit coordinates rather than pixels — a magnitude test, because the
     * file does not say which it wrote.
     *
     * `normalized` makes three call sites skip the rect entirely (the
     * composition map, the scale check, the whole-pixel check), so a rect
     * that lands here by accident disappears from the pane with no
     * explanation. A **zero-size** rect did exactly that: all four corners
     * at the origin satisfy `|x| <= 1`, so a slice that was added and never
     * sized was silently dropped instead of being reported as having no
     * input. Requiring a real size keeps it in view, where `degenerate`
     * below says what is wrong with it.
     *
     * Still imperfect and knowingly so: a genuine 1×1-pixel input rect is
     * indistinguishable from a unit rect by magnitude alone. Telling those
     * apart needs the layer kind, which the three call sites already use to
     * exclude masks — if a real preset ever turns one up, that is the fix.
     */
    normalized: w > 0 && h > 0 && pts.every((p) => Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1),
  }
}

/**
 * Is this polygon a rectangle square to the axes?
 *
 * Only for such a polygon do "overlap by 12×8 px" and "3 px gap above" mean
 * anything: both are read off the bounding box, and a box is the shape
 * itself only when the shape is axis-aligned. Note this is a test of the
 * *polygon*, not of `rot` — a slice rotated by exactly 90° is still square
 * to the axes, and should keep the better message.
 */
export function isAxisAligned(pts: Pt[], tol = 0.01): boolean {
  if (pts.length !== 4) return false
  for (let i = 0; i < 4; i++) {
    const a = pts[i]!
    const b = pts[(i + 1) % 4]!
    if (Math.abs(a.x - b.x) > tol && Math.abs(a.y - b.y) > tol) return false
  }
  return true
}

/**
 * How deeply two convex polygons overlap, by separating axis; null when they
 * do not overlap at all.
 *
 * Needed because the bounding boxes of two rotated slices overlap long
 * before the slices do. Two portrait screens turned 90° and set side by side
 * — the shape a festival's IMAG wings actually take — were reported as
 * colliding when they were merely diagonal neighbours, which sends an LED
 * tech to fix a collision that does not exist.
 *
 * Convex only, which covers every quad. A warp or contour outline can be
 * concave, and for those the caller stays with the bounding box and says so.
 */
export function convexOverlap(a: Pt[], b: Pt[]): number | null {
  let depth = Infinity
  for (const [p, q] of [
    [a, b],
    [b, a],
  ] as const) {
    for (let i = 0; i < p.length; i++) {
      const s = p[i]!
      const e = p[(i + 1) % p.length]!
      // Outward normal of this edge, normalised so the depth is in pixels.
      const len = Math.hypot(e.y - s.y, e.x - s.x)
      if (len < 1e-9) continue
      const nx = (e.y - s.y) / len
      const ny = -(e.x - s.x) / len
      let pMin = Infinity
      let pMax = -Infinity
      for (const v of p) {
        const d = v.x * nx + v.y * ny
        if (d < pMin) pMin = d
        if (d > pMax) pMax = d
      }
      let qMin = Infinity
      let qMax = -Infinity
      for (const v of q) {
        const d = v.x * nx + v.y * ny
        if (d < qMin) qMin = d
        if (d > qMax) qMax = d
      }
      const gap = Math.min(pMax, qMax) - Math.max(pMin, qMin)
      if (gap <= 0) return null
      if (gap < depth) depth = gap
    }
  }
  return Number.isFinite(depth) ? depth : null
}

const parseRect = (el: Element | null): Rect | null =>
  el ? rectFromPts(pointsOf(el), num(el.getAttribute('orientation'))) : null

/**
 * Arena writes a slice's input as `<namespace>:<index>` and keeps the list of
 * choices out of the file. The meaning was worked out from presets whose
 * slice names said what they fed from ("From Main Group" is `1:1`) and from
 * compositions whose layer 17 and 18 were named the same as the screens
 * whose slices read `3:17` and `3:18`. Namespace 2 has not been seen.
 */
export function decodeSource(raw: string): SliceSource {
  const m = /^(\d+):(\d+)$/.exec(raw)
  if (!m) return { raw, kind: 'other', label: raw || 'Composition' }
  const ns = Number(m[1])
  const index = Number(m[2])
  if (ns === 0) return { raw, kind: 'composition', label: 'Composition' }
  if (ns === 1) return { raw, kind: 'group', index, label: `Group ${index}` }
  if (ns === 3) return { raw, kind: 'layer', index, label: `Layer ${index}` }
  return { raw, kind: 'other', label: `Source ${raw}` }
}

/** How far a mesh strays from a flat grid stretched between its corners. */
export function warpDeviation(cols: number, rows: number, verts: Pt[]): number | null {
  if (cols < 2 || rows < 2 || verts.length !== cols * rows) return null
  const c00 = verts[0]!
  const c10 = verts[cols - 1]!
  const c01 = verts[(rows - 1) * cols]!
  const c11 = verts[rows * cols - 1]!
  let dev = 0
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const u = i / (cols - 1)
      const t = j / (rows - 1)
      const ex =
        (1 - u) * (1 - t) * c00.x + u * (1 - t) * c10.x + (1 - u) * t * c01.x + u * t * c11.x
      const ey =
        (1 - u) * (1 - t) * c00.y + u * (1 - t) * c10.y + (1 - u) * t * c01.y + u * t * c11.y
      const v = verts[j * cols + i]!
      dev = Math.max(dev, Math.abs(v.x - ex), Math.abs(v.y - ey))
    }
  }
  return dev
}

/** Piecewise cubic Bézier through control points in groups of four sharing ends. */
export function bezierThrough(ctrl: Pt[], samples = 12): Pt[] {
  const n = ctrl.length
  if ((n - 1) % 3 !== 0) return ctrl.slice()
  const out: Pt[] = []
  for (let s = 0; s + 3 < n; s += 3) {
    const p0 = ctrl[s]!
    const p1 = ctrl[s + 1]!
    const p2 = ctrl[s + 2]!
    const p3 = ctrl[s + 3]!
    for (let k = 0; k < samples; k++) {
      const t = k / samples
      const mt = 1 - t
      const a = mt * mt * mt
      const b = 3 * mt * mt * t
      const c = 3 * mt * t * t
      const d = t * t * t
      out.push({
        x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
        y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
      })
    }
  }
  return out
}

/** The outline of a warp mesh, following its edge control points. */
export function meshBoundary(w: Warp): Pt[] {
  const { cols, rows, verts } = w
  const at = (i: number, j: number) => verts[j * cols + i]!
  const top: Pt[] = []
  const right: Pt[] = []
  const bottom: Pt[] = []
  const left: Pt[] = []
  for (let i = 0; i < cols; i++) top.push(at(i, 0))
  for (let j = 0; j < rows; j++) right.push(at(cols - 1, j))
  for (let i = cols - 1; i >= 0; i--) bottom.push(at(i, rows - 1))
  for (let j = rows - 1; j >= 0; j--) left.push(at(0, j))
  if (w.mode === 'PM_BEZIER') {
    return [
      ...bezierThrough(top),
      ...bezierThrough(right),
      ...bezierThrough(bottom),
      ...bezierThrough(left),
    ]
  }
  return [...top, ...right.slice(1), ...bottom.slice(1), ...left.slice(1, -1)]
}

/** Every row and column of a warp mesh, for drawing over a selected slice. */
export function meshLines(w: Warp): Pt[][] {
  const { cols, rows, verts } = w
  const at = (i: number, j: number) => verts[j * cols + i]!
  const curve = (line: Pt[]) =>
    w.mode === 'PM_BEZIER' ? [...bezierThrough(line), line[line.length - 1]!] : line
  const lines: Pt[][] = []
  for (let j = 0; j < rows; j++) {
    const line: Pt[] = []
    for (let i = 0; i < cols; i++) line.push(at(i, j))
    lines.push(curve(line))
  }
  for (let i = 0; i < cols; i++) {
    const line: Pt[] = []
    for (let j = 0; j < rows; j++) line.push(at(i, j))
    lines.push(curve(line))
  }
  return lines
}

// --- Parsing ------------------------------------------------------------------

function parseLayer(el: Element, index: number): SetupLayer {
  const kind = el.tagName
  const layer: SetupLayer = {
    kind,
    uniqueId: el.getAttribute('uniqueId'),
    name: paramValue(el, 'Common', 'Name', `${kind} ${index + 1}`),
    enabled: bool(paramValue(el, 'Common', 'Enabled', '1')),
    source: decodeSource(paramValue(el, 'Input', 'Input Source', '0:1')),
    inputOpacity: bool(paramValue(el, 'Input', 'Input Opacity', '1')),
    inputBypass: bool(paramValue(el, 'Input', 'Input Bypass/Solo', '1')),
    softEdge: bool(paramValue(el, 'Input', 'SoftEdgeEnable', '0')),
    flip: num(paramValue(el, 'Output', 'Flip', '0')),
    isKey: bool(paramValue(el, 'Output', 'Is Key', '0')),
    blackBg: bool(paramValue(el, 'Output', 'Black BG', '0')),
    invert: bool(paramValue(el, 'Output', 'Invert', '0')),
    input: parseRect(child(el, 'inputrect')),
    output: parseRect(child(el, 'outputrect')),
    warp: null,
    warpSummary: null,
    cornerPinEdited: false,
    contour: null,
  }

  const warper = child(el, 'warper')
  if (warper) {
    const mesh = child(warper, 'bezierwarper')
    if (mesh) {
      const mode = paramValue(warper, 'Warper', 'Point Mode', 'PM_LINEAR')
      const cols = num(mesh.getAttribute('controlWidth'), 4)
      const rows = num(mesh.getAttribute('controlHeight'), 4)
      const verts = pointsOf(child(mesh, 'vertices'))
      const dev = warpDeviation(cols, rows, verts)
      const edited = dev !== null && dev > 0.5
      layer.warpSummary = `${mode === 'PM_BEZIER' ? 'Bézier' : 'Linear'} ${cols}×${rows}${
        dev === null ? '' : edited ? ` · edited (max ${fmt(dev)} px)` : ' · untouched'
      }`
      if (dev !== null && (edited || mode === 'PM_BEZIER')) layer.warp = { mode, cols, rows, verts }
    }
    const homography = child(warper, 'homography')
    if (homography) {
      const src = pointsOf(child(homography, 'src'))
      const dst = pointsOf(child(homography, 'dst'))
      layer.cornerPinEdited = src.some((p, i) => dst[i] !== undefined && dist(p, dst[i]!) > 0.5)
    }
  }

  const shape = child(child(el, 'shapeobject'), 'shape')
  const contour = child(shape, 'contour')
  if (contour) {
    const points = pointsOf(child(contour, 'points'))
    if (points.length >= 3) {
      layer.contour = {
        points,
        segments: child(contour, 'segments')?.textContent?.trim() ?? '',
        closed: contour.getAttribute('closed') !== '0',
      }
    }
  }
  return layer
}

function parseScreen(el: Element, index: number): SetupScreen {
  let device: OutputDevice | null = null
  const deviceEl = child(el, 'outputdevice')?.firstElementChild ?? null
  if (deviceEl) {
    const tag = deviceEl.tagName
    let w = num(deviceEl.getAttribute('width'))
    let h = num(deviceEl.getAttribute('height'))
    if (!(w > 0 && h > 0)) {
      w = num(paramValue(deviceEl, 'Params', 'Width', String(w)), w)
      h = num(paramValue(deviceEl, 'Params', 'Height', String(h)), h)
    }
    device = {
      tag,
      type: tag.replace(/^OutputDevice/i, '') || tag,
      name: deviceEl.getAttribute('name') ?? '',
      deviceId: deviceEl.getAttribute('deviceId') ?? '',
      w,
      h,
      fullscreen: deviceEl.getAttribute('fullscreen') === '1',
    }
  }
  return {
    uniqueId: el.getAttribute('uniqueId'),
    name: paramValue(el, 'Params', 'Name', el.getAttribute('name') ?? `Screen ${index + 1}`),
    enabled: bool(paramValue(el, 'Params', 'Enabled', '1')),
    hidden: bool(paramValue(el, 'Params', 'Hidden', '0')),
    device,
    layers: Array.from(child(el, 'layers')?.children ?? []).map(parseLayer),
  }
}

/**
 * Read an Advanced Output file. Throws with a sentence a crew member can act
 * on when the text is not XML or not one of Arena's two shapes.
 */
export function parseScreenSetup(xml: string, fileName = ''): ScreenSetup {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length > 0) throw new Error('not valid XML')
  const root = doc.documentElement
  let setup: Element | null
  let name = ''
  let format: ScreenSetup['format']
  if (tagOf(root) === 'xmlstate') {
    setup = child(root, 'screensetup')
    name = root.getAttribute('name') ?? ''
    format = 'preset'
  } else if (tagOf(root) === 'screensetup') {
    setup = root
    format = 'preferences'
  } else {
    throw new Error(`not an Advanced Output preset (root element is <${root.tagName}>)`)
  }
  if (!setup) throw new Error('no <ScreenSetup> element')
  if (!name) name = fileName.replace(/\.xml$/i, '') || 'Advanced Output'

  const info = child(root, 'versioninfo') ?? child(setup, 'versioninfo')
  const version = info
    ? `${info.getAttribute('name') ?? 'Resolume'} ${info.getAttribute('majorVersion')}.${info.getAttribute('minorVersion')}.${info.getAttribute('microVersion')}`
    : 'unknown version'
  const size = child(setup, 'currentcompositiontexturesize')
  return {
    name,
    version,
    format,
    comp: { w: num(size?.getAttribute('width')), h: num(size?.getAttribute('height')) },
    screens: childrenOf(child(setup, 'screens'), 'screen').map(parseScreen),
  }
}

// --- The view: ids, colours, derived polygons and checks -----------------------

export interface ScaleInfo {
  sx: number
  sy: number
  tag: '1:1' | 'upscaled' | 'downscaled' | 'non-uniform'
}

export type CheckKind = 'subpx' | 'overlap' | 'gap'

export interface Check {
  kind: CheckKind
  text: string
}

export interface SliceView {
  id: string
  layer: SetupLayer
  screenIndex: number
  index: number
  /** Enabled, on an enabled screen. */
  active: boolean
  hue: number
  color: string
  inPoly: Pt[] | null
  outPoly: Pt[] | null
  /**
   * The bounding boxes of those two polygons, derived once here.
   *
   * Every consumer wants them and `bboxOf` walks the whole polygon, so
   * recomputing was costing real work on the 200-slice target: the checks
   * below, the row sort, each row's sub-line, and three memos inside
   * `ScreenMap` each derived them again. Worst of those was a sort
   * comparator calling it twice per comparison — about 3,400 polygon walks
   * to order 215 rows. `outArea` is kept beside them so that sort is a plain
   * numeric compare.
   */
  inBox: Box | null
  outBox: Box | null
  outArea: number
  inOutside: boolean
  outOutside: boolean
  scale: ScaleInfo | null
  checks: Check[]
}

export interface ScreenView {
  id: string
  index: number
  screen: SetupScreen
  hue: number
  bounds: Box
  /** No device size in the file — the bounds are the slices' extent instead. */
  boundsDerived: boolean
  slices: SliceView[]
}

export interface SetupStats {
  screens: number
  slices: number
  masks: number
  other: number
  disabled: number
  outside: number
  scaled: number
  warped: number
  subpx: number
  overlaps: number
  gaps: number
}

export interface SetupView {
  setup: ScreenSetup
  comp: Box
  compDerived: boolean
  screens: ScreenView[]
  byId: Map<string, SliceView>
  stats: SetupStats
}

const HUES = [0, 215, 130, 38, 275, 185, 320, 62, 250, 100, 20, 160]

/** Neighbours closer than this, but not touching, are almost certainly a mistake. */
export const GAP_PX = 8

function outputPolygon(layer: SetupLayer): Pt[] | null {
  if (layer.contour) return layer.contour.points
  if (layer.warp) return meshBoundary(layer.warp)
  return layer.output?.pts ?? null
}

function scaleInfo(layer: SetupLayer): ScaleInfo | null {
  const { input, output } = layer
  if (!input || !output || layer.kind === 'Mask' || input.normalized) return null
  if (!(input.w > 0 && input.h > 0)) return null
  const sx = output.w / input.w
  const sy = output.h / input.h
  const one = (v: number) => Math.abs(v - 1) < 0.005
  let tag: ScaleInfo['tag'] = '1:1'
  if (!(one(sx) && one(sy))) {
    tag = Math.abs(sx - sy) > 0.01 ? 'non-uniform' : sx > 1 ? 'upscaled' : 'downscaled'
  }
  return { sx, sy, tag }
}

/**
 * The checks an LED tech does by eye, done for them.
 *
 * Whole pixels: a slice placed at x = 2200.65 is resampled by Arena and lands
 * soft on a wall whose pixels are exactly one content pixel each. Overlaps
 * and near-miss gaps are between *enabled* slices on the same screen only —
 * a spare slice that is switched off overlaps everything and harms nothing.
 */
function runChecks(screens: ScreenView[]): void {
  const whole = (v: number) => Math.abs(v - Math.round(v)) < 0.01
  const offGrid = (r: Rect) => r.pts.some((p) => !whole(p.x) || !whole(p.y))
  const where = (r: Rect) => `${fmt(r.bbox.x)}, ${fmt(r.bbox.y)} · ${fmt(r.w)}×${fmt(r.h)}`

  for (const screen of screens) {
    for (const s of screen.slices) {
      s.checks = []
      const { layer } = s
      if (layer.kind !== 'Slice') continue
      // A slice that is switched off is not on the wall, so its placement is
      // not a problem with the wall. `outside` and `scaled` have always
      // filtered this way; these two did not, and a disabled spare slice was
      // the difference between "nothing is warped" and "2 warped".
      if (!s.active) continue
      if (layer.input && !layer.input.normalized && offGrid(layer.input)) {
        s.checks.push({ kind: 'subpx', text: `input not on whole pixels (${where(layer.input)})` })
      }
      if (layer.output && offGrid(layer.output)) {
        s.checks.push({
          kind: 'subpx',
          text: `output not on whole pixels (${where(layer.output)})`,
        })
      }
    }

    const items = screen.slices
      .filter((s) => s.layer.kind === 'Slice' && s.active && s.outPoly)
      .map((s) => ({ s, b: s.outBox ?? bboxOf(s.outPoly!), square: isAxisAligned(s.outPoly!) }))
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i]!
        const c = items[j]!
        // Positive: overlap along that axis. Negative: distance apart.
        const ox = Math.min(a.b.x + a.b.w, c.b.x + c.b.w) - Math.max(a.b.x, c.b.x)
        const oy = Math.min(a.b.y + a.b.h, c.b.y + c.b.h) - Math.max(a.b.y, c.b.y)
        /**
         * Both squared to the axes, so the bounding boxes *are* the shapes
         * and every number below means what it says. Where either is
         * rotated, the boxes overlap long before the slices do, and the
         * per-axis numbers describe nothing: those pairs go through
         * `convexOverlap` for the overlap and skip the gap check, which has
         * no rotated equivalent worth inventing.
         */
        const square = a.square && c.square
        if (!square) {
          if (ox > 0.01 && oy > 0.01) {
            const depth = convexOverlap(a.s.outPoly!, c.s.outPoly!)
            if (depth !== null && depth > 0.01) {
              const by = `${fmt(depth)} px`
              a.s.checks.push({ kind: 'overlap', text: `overlaps “${c.s.layer.name}” by ${by}` })
              c.s.checks.push({ kind: 'overlap', text: `overlaps “${a.s.layer.name}” by ${by}` })
            }
          }
          continue
        }
        if (ox > 0.01 && oy > 0.01) {
          const by = `${fmt(ox)}×${fmt(oy)} px`
          a.s.checks.push({ kind: 'overlap', text: `overlaps “${c.s.layer.name}” by ${by}` })
          c.s.checks.push({ kind: 'overlap', text: `overlaps “${a.s.layer.name}” by ${by}` })
        } else if (ox > 0.01 && -oy > 0.01 && -oy <= GAP_PX) {
          const gap = `${fmt(-oy)} px gap`
          const aAbove = a.b.y < c.b.y
          a.s.checks.push({
            kind: 'gap',
            text: `${gap} to “${c.s.layer.name}” (${aAbove ? 'below' : 'above'})`,
          })
          c.s.checks.push({
            kind: 'gap',
            text: `${gap} to “${a.s.layer.name}” (${aAbove ? 'above' : 'below'})`,
          })
        } else if (oy > 0.01 && -ox > 0.01 && -ox <= GAP_PX) {
          const gap = `${fmt(-ox)} px gap`
          const aLeft = a.b.x < c.b.x
          a.s.checks.push({
            kind: 'gap',
            text: `${gap} to “${c.s.layer.name}” (${aLeft ? 'right' : 'left'})`,
          })
          c.s.checks.push({
            kind: 'gap',
            text: `${gap} to “${a.s.layer.name}” (${aLeft ? 'left' : 'right'})`,
          })
        }
      }
    }
  }
}

/** Everything the panes need, derived once from a parsed setup. */
export function buildView(setup: ScreenSetup): SetupView {
  const byId = new Map<string, SliceView>()
  let inputExtent: Box | null = null

  const screens: ScreenView[] = setup.screens.map((screen, si) => {
    const hue = HUES[si % HUES.length]!
    let outputExtent: Box | null = null
    const slices: SliceView[] = screen.layers.map((layer, li) => {
      const inPoly =
        layer.input && !layer.input.normalized && layer.kind !== 'Mask' ? layer.input.pts : null
      const outPoly = outputPolygon(layer)
      const inBox = inPoly ? bboxOf(inPoly) : null
      const outBox = outPoly ? bboxOf(outPoly) : null
      if (inBox) inputExtent = unionBox(inputExtent, inBox)
      if (outBox) outputExtent = unionBox(outputExtent, outBox)
      const sliceHue = (hue + (li % 4) * 6) % 360
      const view: SliceView = {
        id: `${si}.${li}`,
        layer,
        screenIndex: si,
        index: li,
        active: layer.enabled && screen.enabled,
        hue: sliceHue,
        color: `hsl(${sliceHue} 85% ${50 + (li % 3) * 5}%)`,
        inPoly,
        outPoly,
        inBox,
        outBox,
        outArea: outBox ? outBox.w * outBox.h : 0,
        inOutside: false,
        outOutside: false,
        scale: scaleInfo(layer),
        checks: [],
      }
      byId.set(view.id, view)
      return view
    })
    const d = screen.device
    const sized = !!d && d.w > 0 && d.h > 0
    return {
      id: `s${si}`,
      index: si,
      screen,
      hue,
      bounds: sized
        ? { x: 0, y: 0, w: d.w, h: d.h }
        : (outputExtent ?? { x: 0, y: 0, w: setup.comp.w || 1920, h: setup.comp.h || 1080 }),
      boundsDerived: !sized,
      slices,
    }
  })

  const compDerived = !(setup.comp.w > 0 && setup.comp.h > 0)
  // Assigned inside the map callback above, which the compiler cannot follow.
  const extent = inputExtent as Box | null
  const comp: Box = compDerived
    ? extent
      ? { x: 0, y: 0, w: Math.max(1, extent.x + extent.w), h: Math.max(1, extent.y + extent.h) }
      : { x: 0, y: 0, w: 1920, h: 1080 }
    : { x: 0, y: 0, w: setup.comp.w, h: setup.comp.h }

  for (const screen of screens) {
    for (const s of screen.slices) {
      s.inOutside = s.inBox ? outsideBox(s.inBox, comp) : false
      s.outOutside = s.outBox ? outsideBox(s.outBox, screen.bounds) : false
    }
  }
  runChecks(screens)

  const all = [...byId.values()]
  const has = (kind: CheckKind) => (s: SliceView) => s.checks.some((c) => c.kind === kind)
  const stats: SetupStats = {
    screens: screens.length,
    slices: all.filter((s) => s.layer.kind === 'Slice').length,
    masks: all.filter((s) => s.layer.kind === 'Mask').length,
    other: all.filter((s) => s.layer.kind !== 'Slice' && s.layer.kind !== 'Mask').length,
    disabled: all.filter((s) => !s.active).length,
    outside: all.filter((s) => s.active && (s.inOutside || s.outOutside)).length,
    scaled: all.filter((s) => s.active && s.scale !== null && s.scale.tag !== '1:1').length,
    // `s.active`, like `outside` and `scaled` beside it. A switched-off spare
    // slice with a nudged corner pin is not a warp on anybody's wall, and
    // counting it read as flatly contradicting the neighbouring chips, whose
    // tooltips say "Enabled slices…".
    warped: all.filter((s) => s.active && (s.layer.warp !== null || s.layer.cornerPinEdited))
      .length,
    subpx: all.filter(has('subpx')).length,
    overlaps: all.filter(has('overlap')).length,
    gaps: all.filter(has('gap')).length,
  }
  return { setup, comp, compDerived, screens, byId, stats }
}

/** "Display · Display 2 · 3840×2160 · fullscreen" — the line under a screen's name. */
export function deviceLabel(screen: SetupScreen): string {
  const d = screen.device
  if (!d) return 'no output device'
  const parts = [d.type]
  if (d.name && d.name !== screen.name) parts.push(d.name)
  parts.push(`${fmt(d.w)}×${fmt(d.h)}`)
  if (d.fullscreen) parts.push('fullscreen')
  return parts.join(' · ')
}
