import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
// The same token the server falls back to (server/src/version.ts). They used
// to differ — 'dev' here, 'unknown' there — so a build made outside a git
// checkout produced two version strings that could never match, and the
// client raised "New version available" against a server running the very
// same build, for ever.
let commit = 'unknown'
try {
  commit = execSync('git rev-parse --short HEAD').toString().trim()
} catch {
  // Not a git checkout (a release tarball). Both sides say 'unknown', and
  // the reload pill declines to compare two of those.
}
// e.g. "0.2.0+a1b2c3d" — bump pkg.version for user-facing releases.
const appVersion = `${pkg.version}+${commit}`

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [
    react(),
    VitePWA({
      // 'prompt': never yank a crew member's app out mid-message — surface an
      // "Update available" pill and let them reload when it's safe.
      registerType: 'prompt',
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Crewbox — crew comms',
        short_name: 'Crewbox',
        description: 'Offline-first crew chat for festivals',
        theme_color: '#0d1117',
        background_color: '#0d1117',
        display: 'standalone',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // The app shell loads offline; live data comes over our own WS/API
        // (with its own Dexie cache), so never let the SW intercept those.
        // Server-rendered pages, which the app shell must never stand in
        // for. `/setup` is the one that bit: a box reused for a second event
        // has a service worker cached from the first, so its first-run page
        // — the one that names the event and sets the PIN — was replaced by
        // the app shell, which then asked for a PIN nobody had been given.
        navigateFallbackDenylist: [/^\/api/, /^\/ws/, /^\/connect/, /^\/setup/, /^\/crewbox\.apk/],
        runtimeCaching: [
          {
            // Uploaded files are content-addressed → cache forever once seen.
            urlPattern: ({ url }) => url.pathname.startsWith('/api/files/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'crewbox-files',
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
    }),
  ],
  optimizeDeps: {
    // Workspace package ships TS source; let Vite transform it directly.
    exclude: ['@crewbox/shared'],
  },
  server: {
    host: true, // reachable from other devices on the LAN
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
})
