#!/usr/bin/env node
/**
 * A fake NovaStar COEX controller.
 *
 * No NovaStar hardware has ever been in front of the video module, so this
 * stands in for one: it serves the documented HTTP endpoints on port 8001
 * with the response shapes the manual and the published clients describe.
 * novasun ships `coexsim.py` for the same reason, and the same caveat applies
 * to both — **this reproduces what the documents say, not what firmware
 * does**. It proves the reader handles a plausible controller. It cannot
 * prove the field names are right.
 *
 * Two uses:
 *
 *   node scripts/coex-sim.mjs              # develop the pane without a wall
 *   (the docs screenshot run starts one)   # so a captured shot shows a wall
 *
 * It answers GET and nothing else. A write arriving here is a bug upstream
 * worth seeing, so it is refused loudly rather than ignored.
 */

import { createServer } from 'node:http'

const PORT = Number(process.env.COEX_SIM_PORT ?? 8001)
const HOST = process.env.COEX_SIM_HOST ?? '127.0.0.1'

/**
 * One cabinet per position, laid out as a real wall would be: eight across,
 * three high. Temperatures drift a little around a plausible resting value so
 * a screenshot is not obviously a constant, and one runs hot because a pane
 * that never shows a warning is a pane nobody learns to read.
 */
const CABINETS = Array.from({ length: 24 }, (_, i) => ({
  id: `${String.fromCharCode(65 + Math.floor(i / 8))}${(i % 8) + 1}`,
  screenId: 'Main wall',
  online: true,
  temperature: 38 + ((i * 7) % 9),
}))
// One panel in the sun. The hottest cabinet is what the row reports.
CABINETS[13].temperature = 62

const routes = {
  '/api/v1/device': {
    model: 'MX40 Pro',
    name: 'Main wall',
    sn: 'SIM-0000-0001',
    version: 'V1.4.0',
  },
  '/api/v1/device/cabinet': CABINETS,
  '/api/v1/screen': [{ id: 1, name: 'Main wall', width: 3840, height: 1080, brightness: 62 }],
  // Off, so the pane shows its "SNMP is switched off" note — the state a
  // read-only tool has to surface rather than fix, since switching it on is
  // a write.
  '/api/v1/device/snmpstate': { enable: false },
  '/api/v1/device/monitor/info': {
    temperature: 41,
    fanSpeed: 48,
    cabinets: CABINETS,
  },
  '/api/v1/device/screen/displaymode': { mode: 0 },
  '/api/v1/device/input/sources': [
    { id: 1, name: 'PGM A', type: '12G-SDI', signalStatus: 1 },
    { id: 2, name: 'PGM B', type: '12G-SDI', signalStatus: 1 },
    { id: 3, name: 'Playback', type: 'HDMI 2.0', signalStatus: 2 },
    { id: 4, name: 'Spare', type: 'DP 1.2', signalStatus: 0 },
  ],
  '/api/v1/preset': { presets: [{ id: 1, name: 'Show' }], active: 1 },
  '/api/v1/device/backup': { isBackup: false },
  '/api/v1/device/multifunc-card/detailinfo': { cards: [] },
}

const server = createServer((req, res) => {
  if (req.method !== 'GET') {
    // crewbox cannot construct one of these. If it ever does, this is where
    // it shows up.
    res.writeHead(405, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: 1, message: 'this simulator only answers GET' }))
    return
  }
  const path = new URL(req.url ?? '/', `http://${HOST}`).pathname
  const data = routes[path]
  if (data === undefined) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: 4, message: 'no such endpoint' }))
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ code: 0, data }))
})

server.listen(PORT, HOST, () => {
  console.log(`COEX simulator (MX40 Pro, 24 cabinets) on http://${HOST}:${PORT}`)
})
