# Screen maps

The Video module's second section: Resolume Arena Advanced Output presets,
imported once and shared with everyone on the box. A screen map answers the
question the processor readings cannot — which content is on which wall —
and ties each screen to the processor input that feeds it, so a wall
reporting no signal can be named in terms of the slices that just went dark.

**Status.** Built: the reader for both of Arena's file shapes, the checks,
the maps, the doc-backed store, the feed mapping, watch-file relay, PNG
export. Tested against a synthetic fixture (unit) and through a real box
with two devices (e2e). Not yet: a user-docs page on the site.

## The one rule, again

Crewbox does not talk to Resolume. A screen map is a copy of a file that
Arena wrote; nothing here can change what is on an output, because there is
no encoder for it — no OSC, no REST call to Arena's web server, no file
write. The reader is `web/src/modules/video/model/screenSetup.ts` and it
takes a string and returns objects. The same promise as the rest of the
module (`docs/VIDEO_MONITORING.md`): every phone inherits what the box can
do, and the box can do nothing to a media server.

## Where the file comes from

Arena keeps its screen setups as XML:

- `Documents/Resolume Arena/Presets/Advanced Output/<name>.xml` — a saved
  preset. Root `<XmlState name="…">` wrapping a `<ScreenSetup>`.
- `Documents/Resolume Arena/Preferences/AdvancedOutput.xml` — whatever is on
  the outputs right now. Root `<ScreenSetup>`, with every parameter still at
  its default left out. Arena rewrites it as the setup changes.

Both are read. Defaults are supplied where the preferences file is silent,
which is why every `paramValue` call in the reader names its fallback.

Two ways in, both from the machine that has the file:

1. **Import** on the selector (`/m/video/screens`) — a file picker or a
   drop. The device parses the file and writes the model into a new
   document; the box never sees the XML.
2. **Watch file** on an open map, in Chrome or Edge on the Resolume machine.
   The File System Access API hands the page a handle; it re-reads the file
   whenever its modification time changes and replaces the document's setup.
   Every other device sees the change through the normal relay. A read that
   lands mid-write fails to parse and is retried next tick, keeping the map
   it had. Safari and Firefox lack the API and do not show the button.

There is no agent to install and no box-side code: the operator's browser
is the bridge, and only while that tab is open.

## Sync primitive

A shared doc (`docs/MODULES.md`), one per map, `video/screens-<id>`, plus the
module's index at `video/index`. This is the first document the Video
module has; the processor list stays in the box's settings table for the
reason that document gives — what the box may transmit to must not follow
whichever phone reconnects — and that reason does not apply here. A screen
map is paperwork. Every phone opening it offline is the point.

Inside the doc (`web/src/modules/video/model/screensDoc.ts`):

| Root    | Shape                               | Merges how                                                                                                                                                               |
| ------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `meta`  | `Y.Map` of strings                  | Per field. Title, source file, who imported it and when, who last updated it and when.                                                                                   |
| `setup` | `Y.Map` with one `json` value       | Last writer wins, deliberately. The setup is machine-written; nobody edits corners by hand here, and two imports of the same preset at once should end as the later one. |
| `feeds` | `Y.Map` of `{processorId, inputId}` | Per screen. Keyed by screen _name_, not Arena's `uniqueId`: the id changes when a preset is rebuilt, the name is what the crew keeps.                                    |

The stored setup is a plain object (`ScreenSetup`), so it survives the trip
through Yjs, IndexedDB and JSON unchanged; the view — colours, derived
polygons, checks, statistics — is rebuilt on each device by `buildView`.
Untouched warp meshes are dropped at read time: sixteen vertices per slice
that say "nothing moved" would make a 200-tile LED map's document ten times
the size for every phone on site. What remains is what a person changed.

## What the reader knows

Slice geometry (input and output rectangles as Arena's four corners, so a
rotated slice keeps its own width and height), the input source, enabled
state, the flags a tech asks about (soft edge, flip, key, black background),
masks as their contour, edited warps as their mesh, and the output device
behind each screen.

Input sources are stored as `<namespace>:<index>` with the list of choices
left out of the file. The meaning was worked out from real presets and
compositions rather than documentation: `0:1` is the composition, `1:N` is
group N ("From Main Group" was `1:1`), `3:N` is layer N (screens named Right
and Left read `3:17` and `3:18`, and layers 17 and 18 of the composition were
named Right and Left). Namespace 2 has not been seen and is shown raw.

## The checks

Run on every device from the stored setup, so they are the same everywhere:

- **Sub-pixel** — an input or output rectangle not on whole pixels. Arena
  resamples it, and on a wall that is one content pixel per LED pixel that
  reads as soft edges.
- **Overlap** — two enabled slices whose outputs overlap on one screen.
- **Gap** — two enabled slices on one screen within 8 px of each other but
  not touching. Adjacent tiles are meant to touch; a 1 px gap is a typo.
- Also on the summary line: slices outside the composition or their screen,
  slices whose output size is not their input size, and edited warps.

Disabled slices and masks are left out of overlap and gap checks; a spare
full-screen slice that is switched off overlaps everything and harms nothing.

## Feeds and signal

Each screen card has a "Fed by" menu listing every processor the LED pane
knows and, where the box has read one, its inputs. The choice is stored in
the doc. While the map is open the pane polls `/api/video/state` the way the
LED pane does — paused when hidden, silent when the box does not answer —
and beside the menu says what the box knows about that input: signal
present, no signal, not connected, or that the processor is not being
watched. On a fault it lists the enabled slices on that screen, which is
the sentence somebody on comms actually needs.

## Files

```
web/src/modules/video/
  model/screenSetup.ts        reader, geometry, view, checks (pure)
  model/screensDoc.ts         Y.Doc roots and operations
  store/screensStore.ts       createDocStore config, hooks, seen registry
  ui/ScreenMap.tsx            one pannable map (SVG)
  ui/ScreensSelector.tsx      the list, and the import
  ui/ScreensView.tsx          one map: input, screens, feeds, details
  ui/SliceDetails.tsx         the pinned slice, in words
  ui/testCard.ts              PNG export at the map's resolution
  ui/labels.ts                label placement shared by map and export
  model/__fixtures__/screen-setup.xml   the synthetic preset the tests use
e2e/screens.spec.ts           two devices through a real box
```
