/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      workbox: {
        // Server-rendered/relay routes must never fall back to the cached app
        // shell on devices that have the service worker installed.
        navigateFallbackDenylist: [/^\/connect/, /^\/files\//, /^\/healthz/],
      },
      manifest: {
        name: 'Live Patch',
        short_name: 'Live Patch',
        description: 'Local-first patch sheets for live event production',
        theme_color: '#1a1d23',
        background_color: '#1a1d23',
        display: 'standalone',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
  test: {
    environment: 'node',
    // Playwright specs in e2e/ are not vitest's to run
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
  },
})
