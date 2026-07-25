# Live Patch

Local-first patch sheets for live event production. Manage channel lists, per-artist
patches, sub-boxes, and lineups — on a phone or laptop, with **no internet required**.
Data lives on each device and syncs between crew devices whenever a relay is reachable:
a cloud server when you have connectivity, or a laptop on the venue network when you don't.

This is a ground-up rebuild of the original Next.js/Firebase version, which is preserved
in git history.

## How it works

- **Local-first**: every sheet is a [Yjs](https://yjs.dev) CRDT document persisted in the
  browser's IndexedDB (`y-indexeddb`). The app is a PWA — installable, and fully
  functional offline, forever.
- **Sync is optional and automatic**: configure a relay URL (⚙ Sync settings) and every
  open sheet syncs in real time over websockets (`y-websocket`). Concurrent edits from
  different devices — including edits made offline and synced later — **merge without
  losing data**; that's the CRDT's job, not hand-written conflict code.
- **Access control**: the relay rejects clients that don't present the shared token.
- **The domain is modeled directly** (not as a generic spreadsheet): a sheet has
  channels (rows), artists, per-artist patch entries (Sub-box / Input / Description /
  Mic/DI / Stand), and sub-box definitions referenced by id — so renaming a sub-box
  updates every cell that uses it.

## Features

- Multiple sheets with a synced selector index (title, stage, date)
- Patch grid: channels × artists, five fields per artist, always-editable cells with
  autocomplete suggestions; Enter commits, Escape reverts, arrow keys move between
  cells spreadsheet-style
- **Version snapshots**: save a named copy of the sheet ("after soundcheck",
  "pre-doors") and restore it later — restoring is one undo step, and versions sync
  to other devices with the sheet
- **Google Sheets migration**: paste a copied range straight into the grid (fills
  right/down, adds channels, one undo step), import whole CSVs as new sheets
  (fuzzy header matching, Live Patch export round-trip), find (Ctrl+F) with
  match highlighting, and Ctrl+D fill-down
- Channel management: rename, insert, remove (with per-artist patches cleaned up)
- Lineup manager: artists with start/end times and notes; "← Copy" duplicates the
  previous artist's patch
- Sub-box manager: name, input count, color (shown as a stripe on referencing cells),
  stage position (USC–DSR); deleting a sub-box converts references to plain text
- CSV export (Excel-friendly: UTF-8 BOM, CRLF, proper quoting)
- Live sync status: Local only / Connecting / Synced · N devices

## Getting started

Requires Node ≥ 20.19.

```bash
npm install
npm run dev        # app on http://localhost:5173
```

Other scripts: `npm run build` (typecheck + production build), `npm run preview`,
`npm run lint`, `npm run format`, `npm test`.

The app works immediately with no configuration — sheets are saved on the device.

## Syncing between devices

The recommended setup is the **festival box** — one machine on the venue network that
serves the app, relays sync, and stores attachments; devices that load the app from it
get sync configured automatically. The easiest install is the **single-file app from
[Releases](https://github.com/legofsalmon/livepatch/releases)**: download, double-click,
scan the QR code it shows. See **[DEPLOYMENT.md](DEPLOYMENT.md)** for that, the Docker
and systemd alternatives, and the on-site runbook.

For ad-hoc use, run the relay directly:

```bash
cd server
npm install
LIVEPATCH_TOKEN=choose-a-token npm start        # listens on 0.0.0.0:1234
```

Then on each device: **⚙ Sync settings** → enter the relay URL
(`ws://<machine-ip>:1234` on a LAN, `wss://your-host` behind TLS in the cloud) and the
token. The relay holds documents in memory while clients are connected — the durable
copies are the clients' IndexedDB stores, which re-sync state on every connect.
Attachments are stored under the server's `DATA_DIR`.

Optional build-time defaults for the client: set `VITE_SYNC_URL` and `VITE_SYNC_TOKEN`
in `.env.local` — users can still override them in Sync settings.

## Project structure

```
src/
├── model/          # Domain logic (framework-free, fully unit-tested)
│   ├── types.ts        # Channel/Artist/SubBox/PatchEntry/Sheet types
│   ├── sheetDoc.ts     # Yjs sheet document schema + all mutations
│   ├── indexDoc.ts     # Shared sheet index (selector list)
│   ├── csv.ts          # CSV export
│   ├── date.ts         # Timezone-safe YYYY-MM-DD helpers
│   └── constants.ts    # Suggestions, stage positions, defaults
├── store/          # Persistence + sync + React bindings
│   ├── docManager.ts   # Doc lifecycle, IndexedDB persistence, index upkeep
│   ├── sync.ts         # y-websocket provider management + status
│   ├── syncSettings.ts # Relay URL/token settings
│   ├── useSync.ts      # Sync status/peer hooks
│   └── hooks.ts        # useSheet / useSheetIndex (useSyncExternalStore)
├── ui/             # Components (SCSS modules, tokens in styles/_tokens.scss)
└── styles/
server/             # Standalone token-gated y-websocket relay
scripts/            # PWA icon generator (no external tooling)
```

## Testing

`npm test` runs the Vitest suite over the domain model: sheet operations, sub-box
reference resolution, CSV escaping/layout, date handling, undo/redo semantics, and —
most importantly — concurrent-edit merge scenarios (two devices editing offline,
structural edits racing cell edits, same-cell conflicts converging).

`npm run test:e2e` (after `npm run build` and `npm ci --prefix server`) runs the
Playwright suite against the real relay in box mode: reload persistence, zero-config
two-device sync, presence, token gating, CSV download, and undo across devices. In a
sandbox with a preinstalled Chromium, set `PW_CHROMIUM=<path-to-chrome>`.

Both suites (plus format, lint, and build) run in CI on every pull request
(`.github/workflows/ci.yml`).

## License

MIT
