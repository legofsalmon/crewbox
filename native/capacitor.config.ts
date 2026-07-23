import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.colmhewson.inter',
  appName: 'Inter',
  // The built PWA bundle is packaged into the app; the crew server address
  // is configured at runtime on the join screen (lib/server.ts).
  webDir: '../web/dist',
  server: {
    // The crew server speaks plain HTTP on the LAN — that's the point:
    // native shells don't need the certificate dance the PWA does.
    cleartext: true,
  },
  android: {
    allowMixedContent: true,
  },
}

export default config
