// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderTestCard, testCardPng, type CardSpec } from './testCard.ts'

/**
 * The test card on a device that cannot draw it at full size.
 *
 * Past its limit a browser does not refuse a canvas: it hands one over with
 * nothing behind it, so what is painted reads back transparent and toBlob
 * answers null. The stand-in below does that past a given area, as WebKit
 * does past 4096 x 4096 on iPhones before iOS 18 and 8192 x 8192 since
 * (maxCanvasArea in its CanvasBase.cpp), and as Chromium does past its own
 * limit (checked in a real Chromium: a 32767 x 32767 canvas reads back
 * alpha 0 and toBlob gives null).
 */

const IOS_17 = 4096 * 4096
const IOS_18 = 8192 * 8192

let limit = Infinity
let made: { canvas: HTMLCanvasElement; size: [number, number]; texts: string[] }[] = []
let encoded: [number, number][] = []

const realGetContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext')
const realToBlob = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'toBlob')

beforeEach(() => {
  limit = Infinity
  made = []
  encoded = []
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value(this: HTMLCanvasElement) {
      const texts: string[] = []
      made.push({ canvas: this, size: [this.width, this.height], texts })
      const drawable = this.width * this.height <= limit
      const ctx: Record<string, unknown> = {
        fillText: (text: string) => texts.push(text),
        measureText: (text: string) => ({ width: text.length * 10 }),
        getImageData: () => ({
          data: Uint8ClampedArray.of(...(drawable ? [255, 255, 255, 255] : [0, 0, 0, 0])),
        }),
      }
      // Everything else a card does to a canvas, done to nothing.
      return new Proxy(ctx, {
        get: (target, key: string) => target[key] ?? (() => {}),
        set: () => true,
      })
    },
  })
  Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', {
    configurable: true,
    value(this: HTMLCanvasElement, done: (blob: Blob | null) => void) {
      const drawable = this.width > 0 && this.width * this.height <= limit
      if (drawable) encoded.push([this.width, this.height])
      done(drawable ? new Blob(['png'], { type: 'image/png' }) : null)
    },
  })
})

afterEach(() => {
  if (realGetContext)
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', realGetContext)
  if (realToBlob) Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', realToBlob)
})

const map = (w: number, h: number): CardSpec => ({
  bounds: { x: 0, y: 0, w, h },
  items: [
    {
      poly: [
        { x: 0, y: 0 },
        { x: w, y: 0 },
        { x: w, y: h },
        { x: 0, y: h },
      ],
      name: 'LED',
      sub: `0, 0 // ${w} x ${h}`,
      hue: 200,
    },
  ],
  title: 'Main stage',
})

/** The corner label: the last thing a card writes. */
const sizeLabel = (texts: string[]) => texts[texts.length - 1]

describe('the test card', () => {
  it('is drawn at the map’s own size wherever that fits', () => {
    limit = IOS_17
    const card = renderTestCard(map(1920, 1080))!
    expect(made.map((m) => m.size)).toEqual([[1920, 1080]])
    expect(card).toMatchObject({ scale: 1, deviceLimited: false })
    expect(sizeLabel(made[0]!.texts)).toBe('1920 x 1080')
  })

  it('steps down to what an iPhone before iOS 18 will draw, and says so on the card', () => {
    limit = IOS_17
    const card = renderTestCard(map(7680, 4320))!
    // Full size first, which that phone draws nothing on, then the most it will.
    expect(made).toHaveLength(2)
    expect(made[0]!.size).toEqual([7680, 4320])
    const [width, height] = made[1]!.size
    expect(width * height).toBeLessThanOrEqual(IOS_17)
    expect(width).toBeGreaterThanOrEqual(5460)
    expect(Math.abs(width / height - 7680 / 4320)).toBeLessThan(0.001)
    expect(card.canvas).toBe(made[1]!.canvas)
    expect(card.deviceLimited).toBe(true)
    expect(card.scale).toBeCloseTo(0.7111, 3)
    expect(sizeLabel(made[1]!.texts)).toBe('7680 x 4320 · drawn at 71%')
    // The empty canvas is let go of at once, not left for the collector.
    expect(made[0]!.canvas.width).toBe(0)
  })

  it('draws the same map whole on iOS 18', () => {
    limit = IOS_18
    const card = renderTestCard(map(7680, 4320))!
    expect(made.map((m) => m.size)).toEqual([[7680, 4320]])
    expect(card).toMatchObject({ scale: 1, deviceLimited: false })
  })

  it('never lands a pixel over the limit when it scales', () => {
    // Rounded to the nearest pixel, 4100 x 4800 at the scale that fits
    // becomes 3786 x 4432: 2,336 pixels over, and a blank card.
    limit = IOS_17
    for (const [w, h] of [
      [4100, 4800],
      [4135, 4320],
      [6000, 5000],
      [16384, 1024],
      [40000, 600],
    ] as const) {
      made = []
      expect(renderTestCard(map(w, h)), `${w} x ${h}`).not.toBeNull()
      const [width, height] = made[made.length - 1]!.size
      expect(width * height, `${w} x ${h}`).toBeLessThanOrEqual(IOS_17)
    }
  })

  it('keeps its own cap on a computer, without blaming the device', () => {
    const card = renderTestCard(map(12000, 6000))!
    expect(made).toHaveLength(1)
    const [width, height] = made[0]!.size
    expect(width * height).toBeLessThanOrEqual(64e6)
    expect(card).toMatchObject({ deviceLimited: false })
    expect(sizeLabel(made[0]!.texts)).toBe('12000 x 6000 · drawn at 94%')
  })

  it('gives up rather than handing over a blank card', async () => {
    limit = 1000
    expect(renderTestCard(map(1920, 1080))).toBeNull()
    // Tried once: the second size is no smaller, so would fail the same way.
    expect(made).toHaveLength(1)
    expect(await testCardPng(map(1920, 1080))).toBeNull()
    expect(encoded).toEqual([])
  })

  it('comes back as a PNG, and lets go of the canvas it was drawn on', async () => {
    limit = IOS_17
    const png = await testCardPng(map(7680, 4320))
    expect(png).toMatchObject({ deviceLimited: true })
    expect(png!.blob.type).toBe('image/png')
    expect(encoded).toHaveLength(1)
    expect(encoded[0]![0] * encoded[0]![1]).toBeLessThanOrEqual(IOS_17)
    expect(made.every((m) => m.canvas.width === 0 && m.canvas.height === 0)).toBe(true)
  })
})
