import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.colmhewson.crewbox',
  appName: 'Crewbox',
  // The built PWA bundle is packaged into the app; the crew server address
  // is configured at runtime on the join screen (lib/server.ts).
  webDir: '../web/dist',
  server: {
    // The crew server speaks plain HTTP on the LAN — that's the point:
    // native shells don't need the certificate dance the PWA does.
    cleartext: true,
    // Serve the bundle from http://localhost, not https://: Chromium
    // auto-upgrades "passive" mixed content (images!) from an https page
    // and blocks it when the LAN server can't answer TLS — chat loaded but
    // every photo was a broken chip. An http origin has no mixed content.
    // NB: changing the scheme changes the webview origin and wipes stored
    // sessions — fine before any real distribution, never casually after.
    androidScheme: 'http',
  },
  android: {
    allowMixedContent: true,
  },
}

export default config
