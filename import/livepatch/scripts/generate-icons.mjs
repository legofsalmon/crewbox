// Generates the PWA icons (public/icon-*.png) without external image tooling.
// Run via: npm run icons
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})

const crc32 = (buf) => {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

const encodePng = (size, pixels) => {
  // pixels: Uint8Array of RGBA rows; prepend filter byte 0 per scanline
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const hex = (h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
]

const BG = hex('#1a1d23')
// A stylised patch grid: three columns of "channel" blocks in the app accent colors.
const COLUMNS = [hex('#4dabf7'), hex('#51cf66'), hex('#ffa94d')]

const drawIcon = (size, { padded }) => {
  const px = Buffer.alloc(size * size * 4)
  const set = (x, y, [r, g, b]) => {
    const i = (y * size + x) * 4
    px[i] = r
    px[i + 1] = g
    px[i + 2] = b
    px[i + 3] = 255
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) set(x, y, BG)

  // Grid geometry: content occupies the middle; maskable icons need extra safe padding.
  const margin = Math.round(size * (padded ? 0.22 : 0.16))
  const gap = Math.round(size * 0.045)
  const cols = 3
  const rows = 4
  const cellW = Math.floor((size - 2 * margin - (cols - 1) * gap) / cols)
  const cellH = Math.floor((size - 2 * margin - (rows - 1) * gap) / rows)
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      // Skip one cell per column at staggered rows for a fader-like rhythm
      if ((c === 0 && r === 3) || (c === 1 && r === 0) || (c === 2 && r === 2)) continue
      const x0 = margin + c * (cellW + gap)
      const y0 = margin + r * (cellH + gap)
      for (let y = y0; y < y0 + cellH; y++)
        for (let x = x0; x < x0 + cellW; x++) set(x, y, COLUMNS[c])
    }
  }
  return encodePng(size, px)
}

mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'icon-192.png'), drawIcon(192, { padded: false }))
writeFileSync(join(outDir, 'icon-512.png'), drawIcon(512, { padded: false }))
writeFileSync(join(outDir, 'icon-512-maskable.png'), drawIcon(512, { padded: true }))
console.log('Wrote icon-192.png, icon-512.png, icon-512-maskable.png to public/')
