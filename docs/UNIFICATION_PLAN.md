# Crewbox — Unification Plan

**Crewbox** unifies [inter](https://github.com/legofsalmon/inter) (offline-first crew
chat + push-to-talk voice) and [Live Patch](https://github.com/legofsalmon/livepatch)
(local-first patch sheets) into one application: an offline-first, robust, fast system
for crew communication at temporary events — outdoor music festivals first.

Chat and voice are the **core** every crew member uses. Specialised tools —
patch sheets first; cameras, lighting, video later — are **modules** inside the same
app, sharing one identity, one connection, one install, one box.

This document is the foundation plan: the decisions, the target architecture, and a
phased roadmap. It is grounded in a full architecture review of both codebases
(July 2026).

**Status (July 2026):** Phases 0–4 are done — history merge + rename, shell/module
seam, the shared-docs relay, the full Live Patch port (model, store, UI, e2e), and
the unification features (share-to-chat, admin modules, updated-sheet dots). The
soak test now exercises doc sync alongside chat. Remaining: Phase 5's native
rebrand (needs an Android/Xcode build environment to verify) and the Phase 6
stretch items.

---

## 1. Decisions

Settled with Colm before writing this plan:

| Decision           | Choice                                                                                                                                             | Rationale                                                                                                                                                                                                                                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foundation         | **Inter's codebase is the base.** Crewbox evolves from inter's monorepo; Live Patch ports in as the first module.                                  | Inter already has the platform: identity & sessions, offline outbox with exactly-once delivery, PWA + update flow, native shells (Android alerts service), voice, and the festival-box deploy kit. Live Patch's most valuable layer — its domain model — is framework-free, fully unit-tested, and lifts almost verbatim. |
| Module UX          | **One shell, sidebar sections.** Inter's chat layout is the shell; the sidebar grows module sections (Channels, Direct messages, Patch Sheets, …). | Chat is the common home. Modules are one tap away, share the connection banner, unread badges, search, and the update pill. Revisit (e.g. a module rail) only if the sidebar gets crowded with many modules.                                                                                                              |
| Data compatibility | **Greenfield.** Fresh `crewbox-*` storage names, unified auth, no live-data migration.                                                             | Deployments are per-event and ephemeral. Escape hatches already exist: Live Patch CSV export/import round-trips sheets; inter has an admin JSON export.                                                                                                                                                                   |
| Git history        | **Merge both histories** into crewbox via subtree merges.                                                                                          | `git log`/`blame` keep working for every line — both codebases carry comments referencing bugs fixed in history. Cheap at bootstrap, impossible to retrofit.                                                                                                                                                              |

---

## 2. What each app contributes

### From inter (the platform)

- **Reliability layer** — client-side ids + IndexedDB outbox, server-assigned per-channel
  sequence numbers, resume-from-cursor on reconnect, server-side dedupe ⇒ exactly-once
  delivery. Proven by an integration suite and a 50-client soak test.
- **Identity & auth** — event PIN gates registration, per-user PIN + scrypt, bearer
  session tokens, per-account rate limiting, admin role, session TTL.
- **Server** — Fastify 5 + `ws` + `node:sqlite` (WAL, no native deps), FTS5 search,
  content-addressed file storage with client-rendered thumbnails, LiveKit token minting,
  serves the built web app.
- **Web client** — React 19 + zustand, installable PWA with `prompt`-mode update flow
  ("New version — Reload" bar; never yanks the app mid-task), offline shell + Dexie
  message cache, voice UI (PTT, latch, listen-only degrade).
- **Native** — Capacitor shells; the Android foreground `AlertsService` (own WebSocket,
  lock-screen notifications entirely on-LAN — the thing iOS cannot do offline).
- **Deploy kit** — Caddy + pre-fetched cert + dnsmasq trick (HTTPS with zero internet),
  systemd units, LiveKit config, backup script, QR poster generator, soak test, RUNBOOK.

### From Live Patch (the first module + engineering discipline)

- **Patch-sheet domain model** (`src/model/`) — framework-free, only depends on `yjs`,
  fully unit-tested including concurrent-merge scenarios. Channels × artists grid,
  sub-box references, lineup, version snapshots, CSV import/export with fuzzy header
  matching. **Ports nearly verbatim.**
- **CRDT sync as a second platform primitive** — Yjs docs in IndexedDB (`y-indexeddb`),
  syncing via `y-websocket` rooms whenever a relay is reachable. Offline edits from
  multiple devices merge without conflict code. This becomes a crewbox platform service
  any future module can use (see §3.3).
- **Grid UX** — always-editable cells, spreadsheet keyboard nav, paste-from-Sheets,
  fill-down, find, autocomplete, per-cell presence highlighting, per-field undo that
  never rolls back remote edits.
- **Engineering discipline inter lacks** — ESLint flat config + Prettier, CI (checks +
  Playwright e2e against the real server), a single-file "box" binary build (Node SEA).
  All adopted repo-wide.

---

## 3. Target architecture

### 3.1 Monorepo layout

Inter's workspace layout, renamed and extended:

```
crewbox/
├── shared/                  @crewbox/shared — protocol types, zod schemas, ids
├── server/                  @crewbox/server — Fastify core + platform services
│   └── src/
│       ├── modules/patch/       Yjs relay service (room auth, namespacing)
│       └── …                    hub.ts, store.ts, app.ts etc. (from inter)
├── web/                     @crewbox/web — shell + client modules
│   └── src/
│       ├── shell/               App frame, router, sidebar, services (see §3.2)
│       ├── modules/chat/        inter's chat UI + store (the core module)
│       └── modules/patch/       Live Patch UI + store + model/ (framework-free)
├── native/                  Capacitor shells (from inter)
├── deploy/                  merged festival-box kit
├── e2e/                     Playwright suite (pattern from livepatch)
└── .github/workflows/       CI: format → lint → typecheck → unit → build → e2e
```

Not a separate `packages/` tree for the patch model — it is client-only code; it lives
at `web/src/modules/patch/model/` and keeps its unit tests.

### 3.2 The shell and the module contract

This is the heart of the unification. Both apps currently assume they own the whole
page: inter has no router at all (one `activeChannelId` string + overlay booleans);
Live Patch is a boolean switch over localStorage. The shell introduces the seams both
lack, and the chat refactor to use them is the proof the seams work.

**Shell owns** (modules must not touch these directly):

- **Routing** — a minimal, shell-owned history router (both codebases are deliberately
  dependency-light; we don't need react-router). URLs make everything addressable and
  survive the update-reload: `/c/:channelId`, `/m/patch`, `/m/patch/sheet/:sheetId`.
  The server's SPA fallback (already present) and the SW `navigateFallbackDenylist`
  (`/api`, `/ws`) already support this. Also fixes Android back-button behaviour.
- **Identity & connection** — session token, current user, roster, online/offline state,
  the connection banner. Modules receive these via a module context, never from
  `localStorage` directly (inter has three components reading `inter:token` raw — that
  pattern ends here).
- **Chrome services** — `document.title` (+ aggregated unread badge), a keyboard-shortcut
  registry (module shortcuts active only on module routes — Live Patch's window-level
  Ctrl+Z/F handlers become registrations), a single toast service (Live Patch's
  `ToastProvider` generalised; replaces inter's `flash`), an overlay/dialog layer with
  one z-index scale, theme tokens.
- **PWA** — one manifest (Crewbox name/icons), one service worker, inter's `prompt`-mode
  update flow (wins over livepatch's `autoUpdate` — never reload a stage manager
  mid-task). Runtime cache for `/api/files/` kept.

**Module contract** (client side):

```ts
interface CrewboxModule {
  id: string // 'chat', 'patch'
  title: string // 'Patch Sheets'
  icon: string // inline SVG path (inter convention — no icon fonts)
  load(): Promise<ModuleImpl> // lazy chunk; precedent: inter's dynamic import of LiveKit
}
interface ModuleImpl {
  SidebarSection: Component // rows under the module's sidebar header
  Main: Component // rendered in the main pane for the module's routes
  unreadCount?(): number // contributes to tab title / badges
  // later: searchProvider, adminSection, alertRules
}
```

The sidebar becomes registry-driven instead of two hardcoded JSX sections. Chat itself
registers through the same contract (special only in being the default route), which
keeps the contract honest.

**Server module contract**: a module is a Fastify plugin registered under
`/api/<module>/…` plus optional WebSocket endpoints, receiving the platform services
(store/db, sessions, files, hub broadcast) via injection — the same pattern
`buildApp({ store, … })` already uses.

### 3.3 Two sync primitives, offered as platform services

The deepest architectural fact of this merger: the two apps have **different and
complementary** sync models, and both are correct for their domain. Crewbox keeps both
and offers them as services future modules choose between:

| Primitive       | Model                                                                         | Source     | Right for                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Ordered log** | Server-authoritative per-channel seq, client outbox, ack/resume, exactly-once | inter      | Messages, events, anything append-only where order and delivery guarantees matter (chat; later: cues called, camera tally log) |
| **Shared doc**  | Yjs CRDT, client-durable (IndexedDB), relay in-memory, offline merge          | Live Patch | Collaboratively edited state (patch sheets; later: lighting plots, camera assignments, run sheets)                             |

They stay on **separate WebSocket endpoints** — the chat protocol is a JSON
discriminated union on `/ws`; Yjs speaks its own binary protocol on `/ws/docs/:room`.
No multiplexing; both are authenticated the same way (§3.4).

The Yjs relay moves **into the crewbox server process** (livepatch's standalone
`server/index.cjs` retires): one port, one systemd unit, one health endpoint. The relay
stays stateless by design — durable copies live on crew devices; the box's only
server-side patch state is attachments, which move to inter's files service.

Room names get a namespace — `patch/sheet-<id>`, `patch/index` — enforced server-side
with a per-module authorization hook (livepatch's relay currently accepts any room name
from the client; a flat, global namespace ends here).

### 3.4 One identity everywhere

- Crewbox session (event PIN to register, personal PIN to log in, bearer token) is the
  **only** credential. `LIVEPATCH_TOKEN` and its plaintext-in-localStorage shared secret
  are retired.
- The Yjs WebSocket upgrade validates the session token (same `store.getSessionUser`
  path the REST API uses). Token-in-query-param survives for the upgrade only —
  acceptable on a LAN box, noted as a hardening item for remote-tunnel deployments.
- **Patch presence becomes real identity**: Live Patch's self-assigned display name +
  random device id is replaced by the crewbox user (id, name) in Yjs awareness —
  "Sarah is editing this cell" now means the actual Sarah from chat.
- Artist file attachments move to inter's files API (sha-256 dedupe, client-rendered
  thumbnails, capability URLs, immutable caching). Live Patch's separate `/files/:id`
  endpoint, its `Access-Control-Allow-Origin: *`, and its 25 MB custom uploader retire.
- Roles stay `admin | member` for v1. Department/module scoping is deliberately
  deferred — but the module contract keeps a seam for it (a module can later declare
  visibility rules) so we don't paint ourselves into a corner.

### 3.5 Storage naming (greenfield)

| Kind                        | Name                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------ |
| localStorage                | `crewbox:token`, `crewbox:theme`, `crewbox:server-url`, … (inter's pattern, renamed) |
| Dexie (chat cache + outbox) | db `crewbox`                                                                         |
| y-indexeddb (patch)         | `crewbox-patch-sheet-<id>`, `crewbox-patch-index`                                    |
| Yjs rooms                   | `patch/sheet-<id>`, `patch/index`                                                    |

Two livepatch behaviours do **not** carry over:

- `indexedDB.databases()` enumeration (origin-wide, unavailable in Firefox) — replaced
  by the synced index doc plus a locally-maintained id list.
- `window.__LIVEPATCH_BOX__` origin sniffing — unnecessary: the module gets the server
  origin from the shell (`lib/server.ts`, already tested and native-aware).

### 3.6 Styling

- Inter's CSS custom properties (`--bg`, `--accent`, `--radius`, light/dark via
  `data-theme`) become the **crewbox design tokens**. Live Patch's SCSS token values
  retire; its components restyle onto the shared tokens.
- **Modules use scoped styles** (CSS modules — Live Patch already does this). Inter's
  1,945-line global `app.css` with generic class names (`.row`, `.badge`, `.main`)
  stays for the shell short-term but is a known collision hazard; shell classes get
  namespaced opportunistically as they're touched.
- The shell owns the iOS viewport contract (`body { position: fixed }`,
  `--app-height` from `visualViewport`); the patch grid's sticky headers and scroll
  containers live inside it.

### 3.7 Tooling & stack convergence

| Concern     | Decision                                                                                                                                                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node        | ≥ 22.12 everywhere (server needs `node:sqlite`). Livepatch's separate server project (Node ≥ 18) disappears.                                                                                                                       |
| React       | 19 (both already).                                                                                                                                                                                                                 |
| Vite        | Converge on one major at bootstrap (inter: 7, livepatch: 8 — both on `vite-plugin-pwa` 1.3; expect 8, verify plugin compat).                                                                                                       |
| zod         | v3 (protocol schemas; inter's).                                                                                                                                                                                                    |
| yjs         | 13.6.x (both already agree).                                                                                                                                                                                                       |
| y-websocket | Reconcile the skew: client 3.0.0 vs relay-utils 2.1.0 (wire-compatible via `y-protocols` 1.0.7, but pin deliberately and drop the unused LevelDB tree that v2's utils drag in).                                                    |
| State       | Shell + chat: zustand. Patch module: Yjs + `useSyncExternalStore` internally. No forced convergence — the module boundary is exactly where this difference belongs.                                                                |
| Lint/format | Livepatch's ESLint flat config + Prettier, repo-wide (inter currently has none).                                                                                                                                                   |
| CI          | Livepatch's two-job pattern, extended: format → lint → typecheck → unit (server integration + patch model + web pure fns) → build → Playwright e2e.                                                                                |
| Versioning  | Inter's single build string (`0.1.0+<commit>`) shown in UI, `/api/health`, and `welcome`; drives the update pill. **Add an explicit `protocolVersion` to `welcome`** — neither app has one today, and a module ecosystem needs it. |

---

## 4. What the crew gets from unison

The user-facing payoff that neither app has alone:

1. **One QR, one join** — scan the poster, enter the event PIN once; chat, voice, and
   patch sheets are all there. No second app, no shared token to type into sync
   settings.
2. **Real names on sheets** — patch-sheet presence and edit highlights show the same
   identity as chat.
3. **Sheets in the conversation** — share a sheet into a channel as a link message;
   tapping it deep-links to `/m/patch/sheet/<id>` (possible for the first time because
   the shell has URLs). "Patch updated after soundcheck — @foh check ch 12" becomes one
   message.
4. **One box, one runbook** — a single service to deploy, back up, health-check, and
   power-cycle at 6 a.m.
5. **One update pill** — a redeploy updates chat _and_ patch in lockstep, never
   mid-task, with unsent work protected (chat outbox; patch sheets are CRDTs —
   reloading is always safe).
6. **Offline everywhere, one story** — the PWA shell opens with cached history and
   local sheets even while the box reboots; edits and messages flow when it returns.
7. **A pattern for every department** — cameras, lighting, video modules get identity,
   offline sync (log or doc — their choice), files, presence, deploy, and native
   alerts for free.

---

## 5. Phased roadmap

Each phase leaves the app shippable.

### Phase 0 — Repo bootstrap (history merge + rename)

1. Unshallow local clones; merge histories:
   - `git merge --allow-unrelated-histories inter/main` — inter's layout **is** the
     target root layout.
   - Subtree-merge livepatch under `import/livepatch/` (`git read-tree --prefix=…`);
     later file moves are ordinary commits, `git log --follow` works.
2. Rename: workspaces to `@crewbox/*`, env prefix `CREWBOX_*` (e.g. `CREWBOX_PORT`;
   keep `DATA_DIR`, `WEB_DIST`, `EVENT_PIN`, `LIVEKIT_*` names), brand strings, PWA
   manifest, localStorage keys, Dexie db name.
3. Adopt ESLint/Prettier/CI from the livepatch import; converge Vite; get inter's
   server integration suite and web unit tests green under the new names.

**Done when**: `npm run dev` serves crewbox (= renamed inter) with CI green.

### Phase 1 — Shell & module seam

1. Introduce the router (`/c/:channelId`, module route prefix `/m/<id>`); overlays
   (search/admin/settings/file detail) keep working; update-reload restores location.
2. Registry-driven sidebar; chat becomes the first registered module (no visible
   change). Extract shell services: title/unread aggregation, keyboard registry,
   toasts, overlay layer.
3. `PublicConfig` gains `modules: string[]` (which modules this box enables — it is
   already the live, admin-editable, push-updated config channel).
4. Add `protocolVersion` to `welcome`.
5. De-hardcode `#general` behind a named constant/setting.

**Done when**: chat behaves identically; a stub second module appears in the sidebar
behind a config flag; deep links survive reloads.

### Phase 2 — Server platform for shared docs

1. Mount the Yjs relay in the crewbox server on `/ws/docs/:room` (from
   `y-websocket`'s server utils, version reconciled): session-token auth on upgrade,
   `patch/` namespace enforcement, connection counts in `/api/health`.
2. Extend the files service for module attachments (patch artist files): same dedupe,
   thumbs, capability URLs.
3. Integration tests in inter's style: auth rejected/accepted, room scoping, two
   clients converge, relay restart loses nothing (clients re-seed).

**Done when**: a bare Yjs client can sync a doc through the crewbox server with a
crewbox session, and can't without one.

### Phase 3 — Port Live Patch as the patch module

1. Lift `model/` verbatim with its unit tests (they run against Y.Doc, no changes).
2. Refactor the store layer against crewbox seams: `SyncManager` instantiated with
   injected origin+token (no module-scope singletons, no `import.meta.env` token
   baking); storage names per §3.5; awareness user = crewbox identity;
   **id-generation fallback** for non-secure contexts (see Risks — this is a real
   crash today in native webviews).
3. Restyle UI onto crewbox tokens; register `SidebarSection` (sheet list from the index
   doc) and `Main` (selector/sheet views on `/m/patch/…`); keyboard shortcuts via the
   registry; toasts via the shell service.
4. Attachments through the files API; CSV import/export unchanged.

**Done when**: livepatch's model unit tests and ported e2e scenarios (two-device sheet
sync, offline reload, undo isolation, paste import) pass against a crewbox box with
crewbox sessions.

### Phase 4 — Product unification polish

1. Share-sheet-to-channel: a link message rendering a sheet card, deep-linking into the
   module.
2. Unread/badge integration (`unreadCount` contract), patch presence avatars using crew
   identity, admin panel gains a modules section.
3. Poster/runbook copy updated to one join flow.

### Phase 5 — Deploy & native

1. Merged deploy kit: `crewbox.service`, Caddyfile, backup (DATA_DIR already covers
   SQLite + files; relay is stateless), poster, RUNBOOK; soak test extended to exercise
   doc sync alongside chat.
2. Native rebrand (new appId `com.colmhewson.crewbox` — greenfield makes the
   origin/session wipe a non-issue), Android `AlertsService` unchanged in protocol,
   APK QR on the poster; App Store checklist refresh for iOS.

### Phase 6 — Stretch

- **Single-binary box build** (livepatch's Node SEA pattern applied to the whole
  crewbox server — feasible: `node:sqlite` is stdlib; needs an esbuild step replacing
  runtime tsx). Download, double-click, scan the QR: the smallest events get the full
  stack.
- Optional relay-side doc persistence (y-websocket's LevelDB hook) if a box-holds-state
  story is ever wanted; **not** default.
- Next modules (cameras / lighting / video) on the established contracts; department
  visibility/roles when a real module needs it.

---

## 6. Risks & mitigations

| Risk                                                     | Detail                                                                                                                                                                                                   | Mitigation                                                                                                                                                                                                                          |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`crypto.randomUUID` in non-secure contexts**           | Livepatch calls it at module scope; it's undefined on plain-HTTP LAN origins — and **inter's Android webview is exactly that** (`androidScheme: 'http'`, deliberate). Hard boot crash if ported naively. | All id generation goes through `@crewbox/shared`'s `newId()` (works everywhere) or a UUID helper with a non-crypto fallback. Lint rule against direct `crypto.randomUUID`. Phase 3 acceptance includes running in the native shell. |
| y-websocket client/server major skew                     | Client 3.0.0, relay utils 2.1.0 — works today via `y-protocols` 1.0.7, silently fragile.                                                                                                                 | Pin one version at Phase 2; add a wire-compat integration test; drop the unused LevelDB dependency tree.                                                                                                                            |
| CSS collisions between shell and modules                 | Inter's global stylesheet uses very generic class names.                                                                                                                                                 | Modules: scoped styles only (enforced in review). Shell: namespace opportunistically; tokens are the shared surface.                                                                                                                |
| SW/manifest ownership                                    | Both apps currently register their own SW at scope `/` with their own manifest and update policy.                                                                                                        | Shell owns both; `prompt` mode; modules never touch SW APIs.                                                                                                                                                                        |
| Keyboard/title/global-listener fights                    | Both apps bind window-level handlers and write `document.title`.                                                                                                                                         | Shell registry (Phase 1); module handlers active only on module routes; dialogs use the shared overlay layer's single Escape handler.                                                                                               |
| Session token in Yjs upgrade query string                | Appears in server logs / proxy logs.                                                                                                                                                                     | Fine on the LAN box (logs are ours). For tunnel deployments: short-lived WS ticket endpoint, listed in the RUNBOOK hardening section alongside inter's existing remote-access guidance.                                             |
| Yjs doc growth (version snapshots embed full sheet JSON) | Unbounded doc growth synced to every device.                                                                                                                                                             | Accept for v1 (real sheets are small); add snapshot pruning/limits when it hurts; keep an eye via the e2e data sizes.                                                                                                               |
| Big-sheet re-render cost inside a busier shell           | Patch rebuilds the full sheet snapshot per doc update.                                                                                                                                                   | Measure once embedded (Phase 3); memoise per-root snapshots only if needed.                                                                                                                                                         |
| Protocol evolution across modules                        | Chat's WS union is closed; server→client frames aren't runtime-validated.                                                                                                                                | Modules don't extend the chat union — they get their own endpoints. `protocolVersion` in `welcome` from Phase 1. Zod-validate server frames where cheap.                                                                            |
| Scope creep before the seam is proven                    | The module contract could over-generalise.                                                                                                                                                               | The contract is validated by exactly two consumers (chat, patch) before any new module is designed. Anything speculative (search providers, alert rules, department roles) stays deferred until a module needs it.                  |

---

## 7. Open questions (non-blocking, decide during build)

- **Patch sheets ↔ chat channels**: should a sheet optionally _belong_ to a channel
  (e.g. `#stage-a`) for grouping/permissions, or stay a flat per-event list (Live
  Patch's current model)? Flat for v1; revisit with real use.
- **Voice while in a module**: the VoiceBar is shell chrome and stays visible on module
  routes (PTT while editing a sheet) — confirm the interaction feels right on phones.
- **Naming in the UI**: "Patch Sheets" as the sidebar section title; whether "Live
  Patch" survives as a brand inside crewbox or fully dissolves.
- **Mentions from modules**: should a sheet share ping `@foh`-style mentions through
  chat's alert path (including Android lock-screen alerts)? Natural fit, Phase 4+.

---

## 8. Source references

The full architecture reviews behind this plan (file-level detail, line references):
carried out July 2026 against `legofsalmon/inter@586bdd7` and
`legofsalmon/livepatch@23d20ec`. Key facts used here: inter's protocol/reliability
contract (`shared/src/protocol.ts`, `server/src/hub.ts`, `server/src/store.ts`), its
shell structure (`web/src/App.tsx`, `web/src/store.ts`), the deploy kit
(`deploy/RUNBOOK.md`); livepatch's domain model (`src/model/sheetDoc.ts`), store
singletons (`src/store/sync.ts`, `src/store/docManager.ts`), relay
(`server/index.cjs`), and SEA packaging (`scripts/build-sea.mjs`).
