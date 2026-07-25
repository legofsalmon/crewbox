// One-off generator: renders public/icon.svg into the PNG sizes PWAs need.
// Run with: node scripts/make-icons.mjs
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import sharp from 'sharp'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')
const svg = await readFile(join(root, 'icon.svg'))

const targets = [
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
  { file: 'apple-touch-icon.png', size: 180 },
]

for (const { file, size } of targets) {
  await sharp(svg, { density: 300 }).resize(size, size).png().toFile(join(root, file))
  console.log(`wrote ${file}`)
}

// Maskable: same mark with extra safe-area padding on a solid tile.
const padded = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
     <rect width="512" height="512" fill="#12100e"/>
     <g transform="translate(76.8 76.8) scale(0.7)">
       <path d="M116 312a140 140 0 0 1 280 0" fill="none" stroke="#f5b73e" stroke-width="34" stroke-linecap="round"/>
       <path d="M186 312a70 70 0 0 1 140 0" fill="none" stroke="#f5b73e" stroke-width="34" stroke-linecap="round"/>
       <circle cx="256" cy="342" r="38" fill="#f5b73e"/>
     </g>
   </svg>`
)
await sharp(padded, { density: 300 })
  .resize(512, 512)
  .png()
  .toFile(join(root, 'icon-maskable-512.png'))
console.log('wrote icon-maskable-512.png')
