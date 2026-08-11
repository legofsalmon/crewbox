# Adding a department module

Crewbox is a shell plus modules. The shell owns the things every crew needs
regardless of department — identity, the roster, connection state, routing,
offline storage, the service worker, toasts, keyboard shortcuts, the tab
title. A module owns one department's work: a sidebar section and, usually,
the main pane behind its `/m/<id>` routes.

Chat is itself a module. It is special only in being the default view, so it
owns `/c/<channelId>` rather than `/m/chat`.

This document is the practical path from "we want a module for the lighting
crew" to a working one. It describes what exists today, not a plan.

## Shell state vs a module's own

Before either primitive, ask whether the data is a department's at all. The
**timetable** — who is on, where, and when — is consulted by audio, lighting,
stage management and anything that timestamps against a set, so it lives in
`web/src/shell/timetable/` rather than in a module. A box that turns a module
off must not lose it.

Shell state gets its own relay namespace, listed in `SHELL_NAMESPACES`
(`server/src/docs.ts`), and is always reachable regardless of
`CREWBOX_MODULES`. The Schedule module is the _screen_ for the timetable, not
its owner: turn the module off and the data is still there for everything
else.

The rule of thumb: if two departments would both want to edit it, it is the
event's and belongs to the shell. If only one would, it is that module's.

## The two sync primitives

Pick one before you write anything else, because everything downstream
follows from it.

**Ordered log** — an append-only stream where order and exactly-once
delivery matter, and history is the point. Chat uses it: per-channel
sequence numbers, a client-id outbox, resume-from-cursor, server-side
dedupe. Reach for it when the question is "what happened, in what order" —
incident logs, show calls, cue-fired records.

**Shared doc** — a CRDT document many people edit at once, where the current
state is the point and edits merge without a server arbitrating. Patch
sheets use it: a Yjs doc per sheet, relayed through `/ws/docs`. Reach for it
when the question is "what is the current state of this thing" — patch
sheets, lighting plots, camera positions, run sheets.

Most department modules want the shared doc. The rest of this document
assumes that.

## What the shared doc-store gives you

`web/src/modules/_shared/docs/` is the lifecycle every doc-backed module
needs, extracted so the second module isn't a copy of the first:

| File          | What it handles                                                                              |
| ------------- | -------------------------------------------------------------------------------------------- |
| `store.ts`    | Y.Doc lifecycle, IndexedDB persistence, the local registry, creation, deletion               |
| `sync.ts`     | y-websocket providers, crew-identity presence, peer lists                                    |
| `indexDoc.ts` | The index doc listing every document, so a selector can show docs that live on other devices |
| `hooks.ts`    | `useDocSnapshot`, `useStoreDoc`, `useDocIndex`, sync status/peers                            |
| `seen.ts`     | Per-device "seen" times behind the sidebar's updated dot                                     |

You declare a config; the store does the rest.

```ts
export const plotStore = createDocStore({
  moduleId: 'lighting',
  docName: (id) => `plot-${id}`,
  localOrigin: LOCAL_ORIGIN,
  defaultTitle: 'Untitled Plot',
  undoManager: createPlotUndoManager,
  indexFields: (doc) => {
    const { meta } = getPlotRoots(doc)
    return { title: (meta.get('title') as string) ?? 'Untitled Plot' }
  },
})
```

### Naming reaches real devices

Three names are derived from `moduleId` and `docName`, and all three end up
in storage on phones in the field:

```
IndexedDB db    crewbox-<moduleId>-<docName>
relay room      <moduleId>/<docName>
registry key    crewbox:<moduleId>-docs
```

Changing any of them after a module has shipped strands data. Pick
`moduleId` once and leave it alone. `registryKey` exists as an override only
because the patch module shipped before this store did.

## The five steps

### 1. Model

`modules/<id>/model/` — plain functions over a `Y.Doc`, no React, no
storage. Export a `LOCAL_ORIGIN` constant and stamp every local edit with it
(`doc.transact(fn, LOCAL_ORIGIN)`); the store uses it to tell your edits
from IndexedDB loads and remote sync, which is what keeps undo scoped to
your own changes and `lastModified` honest.

This layer is where the unit tests go. It's pure Yjs, so a test can create
two docs, edit both, exchange updates, and assert convergence — no browser
needed. See `modules/patch/model/sheetDoc.test.ts`.

### 2. Store

`modules/<id>/store/` — the `createDocStore` config above, plus any
module-specific hooks wrapping the shared ones. Keep it thin. If you find
yourself writing doc lifecycle here, it probably belongs in `_shared/docs`.

### 3. UI

`modules/<id>/ui/` — components. Use CSS custom properties from
`web/src/app.css` (`--bg`, `--bg-raised`, `--text`, `--accent`,
`--accent-contrast`, `--border`) rather than literal colours. Crew use this
outdoors in daylight and in a dark FOH tent; both themes have to work, and
hardcoded whites are how the patch module ended up with invisible text in
one theme and an invisible button in the other. `e2e/theme.spec.ts` guards
the contrast ratios.

Every top-level view a module renders **must** include the shell's
`<DrawerButton />` at the start of its header. Navigating to a module closes
the sidebar drawer, so a pane without one strands a phone user inside it
with no way back to chat or to any other module. The button hides itself
above 900px. `e2e/lighting.spec.ts` guards this for both modules.

### 4. Register

`modules/<id>/index.ts` exports a `CrewboxModule`:

```ts
export const lightingModule: CrewboxModule = {
  id: 'lighting',
  title: 'Lighting',
  SidebarSection: LightingSidebar,
  Main: LightingMain,
}
```

Add it to `allModules` in `web/src/shell/registry.ts`.

### 5. Enable it on the box

A module in the registry is not automatically visible. The box decides:

```
CREWBOX_MODULES=patch,lighting
```

`server/src/config.ts` reads it, `/api/config` publishes it to clients, and
`enabledModules()` filters the sidebar. The same list gates the docs relay —
`parseRoomName` in `server/src/docs.ts` rejects rooms whose module isn't
enabled, so a client can't sync a module the box has turned off. Chat is
always on.

## Talking to the rest of the shell

- **Routing** — `shell/router.ts`. Your module owns `/m/<id>/<subpath>`, and
  `Main` receives `subpath`. Deep links matter: crew share them in chat.
- **Share to chat** — a message body containing `/m/<id>/...` renders as an
  "Open ↗" chip that jumps straight into your module. Nothing to register;
  post the path.
- **Identity** — `useStore().me` is the crew member from the roster. Don't
  invent a module-local display name; presence should say the same Sarah
  chat says.
- **Shortcuts** — `shell/keys.ts`. Register with a `when` guard so your
  binding doesn't fire while someone is typing in a composer.
- **Unread** — `unreadCount` on the module contributes to the tab title.

## Offline is the default, not a mode

Assume no network. Festivals lose their uplink, crew walk out of Wi-Fi
range, and phones sleep. The shared doc-store already gives you local-first
behaviour — docs open from IndexedDB, edits apply immediately, and sync
reconciles when a provider reconnects. What you have to avoid is undoing
that: don't block rendering on a network round-trip, don't treat "not
synced" as an error state, and don't assume `crypto.randomUUID` exists (use
`newId()` from `@crewbox/shared` — the Android webview isn't always a secure
context).

## Testing a module

| Layer      | Where                        | What it proves                              |
| ---------- | ---------------------------- | ------------------------------------------- |
| Model      | `model/*.test.ts` (vitest)   | Domain logic and CRDT convergence           |
| Relay      | `server/test/` (vitest)      | Room namespacing and auth                   |
| End to end | `e2e/*.spec.ts` (Playwright) | Two real devices syncing through a real box |

The e2e layer is the one that catches the interesting failures, because it
runs the actual server, the actual relay, and two isolated browser contexts.
`e2e/helpers.ts` has `newDevice`, which joins through the real flow.
