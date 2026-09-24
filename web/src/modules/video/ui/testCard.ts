import { bboxOf, fmt, type Box, type Pt } from '../model/screenSetup.ts'
import { resolveOverlaps } from './labels.ts'

/**
 * A test card at the map's own resolution: a checkerboard per slice with
 * its name, position and size in the middle, the way a content template is
 * sent to a designer or held up against a wall. The input map shows where
 * on the composition each screen is looking; a screen's map shows what its
 * output should carry.
 */

export interface CardItem {
  poly: Pt[]
  name: string
  /** "0, 0 // 2112 x 1152" */
  sub: string
  hue: number
}

const MAX_SIDE = 16384
/**
 * How many pixels a card may have, largest first. The first is ours: past
 * it a card is drawn smaller rather than ask for more than a quarter of a
 * gigabyte. The second is the most an iPhone or iPad before iOS 18 will
 * draw, 4096 x 4096 of area (iOS 18 raised it to 8192 x 8192: WebKit
 * 276145@main).
 *
 * Past its limit a browser does not refuse the canvas. It hands one over
 * with no pixels behind it, everything drawn on it vanishes, and the PNG
 * comes back empty — which is how a map over 16.7 megapixels, an 8K
 * canvas say, failed to export on those phones. So each size is tried in
 * turn, and the first canvas that keeps what is painted on it is used.
 */
const PIXEL_BUDGETS = [64e6, 4096 * 4096]
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'

const textWidth = (ctx: CanvasRenderingContext2D, text: string, size: number, weight: number) => {
  ctx.font = `${weight} ${size}px ${FONT}`
  return ctx.measureText(text).width
}

const fitFont = (
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
  size: number,
  weight: number
) => {
  const tw = textWidth(ctx, text, size, weight)
  return tw > maxW ? (size * maxW) / tw : size
}

const labelBox = (
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size: number,
  weight: number,
  bg: string,
  fg: string,
  align: 'center' | 'right' = 'center'
) => {
  ctx.font = `${weight} ${size}px ${FONT}`
  ctx.textBaseline = 'middle'
  const tw = ctx.measureText(text).width
  const pad = size * 0.3
  const left = align === 'right' ? x - tw - pad : x - tw / 2 - pad
  ctx.fillStyle = bg
  ctx.fillRect(left, y - size * 0.62, tw + pad * 2, size * 1.24)
  ctx.fillStyle = fg
  ctx.textAlign = 'left'
  ctx.fillText(text, left + pad, y)
}

export interface TestCard {
  canvas: HTMLCanvasElement
  /** Below 1 when the card is smaller than the map. */
  scale: number
  /** This device could not draw the size the card should have been. */
  deviceLimited: boolean
}

export interface CardSpec {
  bounds: Box
  items: CardItem[]
  title: string
}

/** Drop a canvas's pixels now, rather than whenever it is collected. */
const release = (canvas: HTMLCanvasElement) => {
  canvas.width = 0
  canvas.height = 0
}

/** Whether the canvas kept the white just painted on it. */
const holdsPixels = (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) => {
  try {
    return ctx.getImageData(canvas.width - 1, canvas.height - 1, 1, 1).data[3] !== 0
  } catch {
    return false
  }
}

/** The card as large as this device will draw it, or null if it will not. */
export function renderTestCard(spec: CardSpec): TestCard | null {
  const { w, h } = spec.bounds
  let deviceLimited = false
  let failedAt = Infinity
  for (const budget of PIXEL_BUDGETS) {
    let scale = 1
    if (w > MAX_SIDE || h > MAX_SIDE) scale = Math.min(MAX_SIDE / w, MAX_SIDE / h)
    if (w * h * scale * scale > budget) scale = Math.min(scale, Math.sqrt(budget / (w * h)))
    // Down, when scaled: rounding both sides up can land a few pixels over
    // the budget, and one pixel over is a canvas with nothing on it.
    const side = (n: number) => Math.max(1, scale < 1 ? Math.floor(n * scale) : Math.round(n))
    const [width, height] = [side(w), side(h)]
    // Only ever smaller: the same size again would fail the same way.
    if (width * height >= failedAt) continue

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      if (holdsPixels(ctx, canvas)) {
        drawCard(ctx, spec, scale)
        return { canvas, scale, deviceLimited }
      }
    }
    release(canvas)
    deviceLimited = true
    failedAt = width * height
  }
  return null
}

/** The card as a PNG, and the canvas it was drawn on let go of. */
export async function testCardPng(
  spec: CardSpec
): Promise<{ blob: Blob; scale: number; deviceLimited: boolean } | null> {
  const card = renderTestCard(spec)
  if (!card) return null
  try {
    const blob = await new Promise<Blob | null>((resolve) =>
      card.canvas.toBlob(resolve, 'image/png')
    )
    return blob && { blob, scale: card.scale, deviceLimited: card.deviceLimited }
  } finally {
    release(card.canvas)
  }
}

function drawCard(
  ctx: CanvasRenderingContext2D,
  { bounds, items, title }: CardSpec,
  scale: number
) {
  const { w, h, x: ox, y: oy } = bounds
  ctx.save()
  ctx.scale(scale, scale)
  ctx.translate(-ox, -oy)

  const minDim = Math.min(w, h)
  const tile = Math.min(256, Math.max(8, Math.round(minDim / 16)))
  const base = Math.min(200, Math.max(10, minDim / 22))
  const lineW = Math.max(1, minDim / 700)

  const tracePoly = (poly: Pt[]) => {
    ctx.beginPath()
    poly.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)))
    ctx.closePath()
  }

  for (const it of items) {
    const bb = bboxOf(it.poly)
    ctx.save()
    tracePoly(it.poly)
    ctx.clip()
    ctx.fillStyle = `hsl(${it.hue} 95% 50%)`
    ctx.fillRect(bb.x, bb.y, bb.w, bb.h)
    ctx.fillStyle = `hsl(${it.hue} 95% 26%)`
    const nx = Math.ceil(bb.w / tile)
    const ny = Math.ceil(bb.h / tile)
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if ((i + j) & 1) ctx.fillRect(bb.x + i * tile, bb.y + j * tile, tile, tile)
      }
    }
    ctx.strokeStyle = 'rgba(255,255,255,.6)'
    ctx.lineWidth = lineW
    ctx.beginPath()
    ctx.arc(bb.x + bb.w / 2, bb.y + bb.h / 2, (Math.min(bb.w, bb.h) / 2) * 0.95, 0, Math.PI * 2)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(bb.x, bb.y)
    ctx.lineTo(bb.x + bb.w, bb.y + bb.h)
    ctx.moveTo(bb.x + bb.w, bb.y)
    ctx.lineTo(bb.x, bb.y + bb.h)
    ctx.stroke()
    ctx.restore()
    ctx.strokeStyle = 'rgba(255,255,255,.9)'
    ctx.lineWidth = lineW
    tracePoly(it.poly)
    ctx.stroke()
  }

  // Labels on top of everything; where slices stack, later ones move down.
  const labels: {
    name: string
    sub: string
    size: number
    sizeSub: number
    cx: number
    rect: Box
  }[] = []
  for (const it of items) {
    const bb = bboxOf(it.poly)
    if (bb.h < 10 || bb.w < 10) continue
    let size = Math.min(base, bb.h / 3.2)
    size = fitFont(ctx, it.name, bb.w * 0.9, Math.max(4, size), 700)
    const sizeSub = fitFont(ctx, it.sub, bb.w * 0.9, size * 0.55, 400)
    const width = Math.max(
      textWidth(ctx, it.name, size, 700) + size * 0.6,
      sizeSub >= 3 ? textWidth(ctx, it.sub, sizeSub, 400) + sizeSub * 0.6 : 0
    )
    const cx = bb.x + bb.w / 2
    const cy = bb.y + bb.h / 2
    labels.push({
      name: it.name,
      sub: it.sub,
      size,
      sizeSub,
      cx,
      rect: { x: cx - width / 2, y: cy - 1.07 * size, w: width, h: 1.62 * size + 0.62 * sizeSub },
    })
  }
  resolveOverlaps(
    labels.map((l) => l.rect),
    minDim / 200
  )
  for (const l of labels) {
    const cy = l.rect.y + 1.07 * l.size
    labelBox(ctx, l.name, l.cx, cy - l.size * 0.45, l.size, 700, '#000', '#fff')
    if (l.sizeSub >= 3)
      labelBox(ctx, l.sub, l.cx, cy + l.size * 0.55, l.sizeSub, 400, '#fff', '#000')
  }

  const fs = Math.min(120, Math.max(10, minDim / 30))
  labelBox(ctx, title, ox + w - fs * 0.6, oy + h - fs * 2.55, fs, 400, '#fff', '#000', 'right')
  // The file goes on to a designer who never sees the app: a card drawn
  // smaller than the map says so on itself.
  const size = `${fmt(w)} x ${fmt(h)}`
  labelBox(
    ctx,
    scale < 1 ? `${size} · drawn at ${percentOf(scale)}%` : size,
    ox + w - fs * 0.6,
    oy + h - fs * 1.05,
    fs,
    400,
    '#000',
    '#fff',
    'right'
  )
  ctx.restore()
}

/** Down, so a card at 99.6% never claims to be 100%. */
export const percentOf = (scale: number) => Math.max(1, Math.floor(scale * 100))
