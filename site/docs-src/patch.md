---
title: Patch sheets
section: Patch sheets
order: 10
blurb: The master patch as a live grid — sheets, editing, undo, versions and sharing.
---

# Patch sheets

A patch sheet is the festival master patch as a live document: channels down
the side, acts across the top, and every phone and laptop on the crew
editing the same grid at once. It works offline, syncs when connected, and
never makes you pick who has "the real copy" — the sheet is the real copy.

## Sheets

![The sheet list, with a festival master patch imported](shot:patch-sheets)

The **Patch Sheets** section of the sidebar lists your recent sheets;
**All sheets…** opens the full list. From there:

- **+ New Sheet** starts one blank.
- **⇪ Import CSV** builds one from a spreadsheet export —
  [the import page](/docs/patch-paste-and-import) covers what it
  understands, including real festival master patches.
- Each card shows title, stage, date and when it was last edited. A dot on a
  sidebar sheet means it changed since you last opened it.
- The `×` deletes a sheet **from this device and the shared index** — it
  asks first.

Open a sheet and the toolbar carries: **Stage** and **Date** fields, a
**Find** box (`⌘F`; Enter walks the matches), **undo/redo**, and the five
dialogs — **Boxes**, **Stage Patch**, **Lineup**, **Versions**, **Share**,
**Export**.

## The grid

![The master patch grid: channels down, acts across](shot:patch-grid)

Rows are desk channels; each act gets a column group of five fields:
**Sub-box · Input · Description · Mic/DI · Stand**.

- The channel row itself holds the channel label and the **house input** —
  what's on that channel all day. An act's own Input field overrides it for
  their set. ("CH 1, house input Kick In — but for the headliner it's their
  own kick mic.")
- Cells autocomplete from what's already been typed for that field, and
  keyboard navigation works like a spreadsheet — arrows, Enter to commit
  and move, `⌘D` to fill down, Escape to abandon an edit
  ([all shortcuts](/docs/shortcuts)).
- **← Copy** in an act's header copies the previous act's whole patch — the
  fastest start for a shared backline.
- **+ Add Channel** at the bottom grows the sheet.

![The grid on a phone](shot:patch-grid-phone)

## Editing together

Everyone edits at once, and it converges — that's the point:

- A coloured ring on a cell with a name tooltip means a colleague is in that
  cell right now.
- The **sync chip** by the title tells the truth: **Local only** (never
  synced), **Connecting…**, **Synced**, or **Synced · 3 devices**.
- Offline edits are kept and merge cleanly when you're back in reach.
- **Undo is yours alone**: `⌘Z` reverts what _you_ did, never a
  colleague's change — so nobody can undo the monitor engineer from across
  the field.

## Versions

![Named versions of a sheet, ready to restore](shot:patch-versions)

**Versions** saves named snapshots — "After soundcheck", "As advanced" —
with a timestamp and size. **Restore** replaces the sheet's current content
with the snapshot (it asks first, and the restore itself can be undone).
Versions sync, so a snapshot taken at FOH is restorable from the stage.

## Share and export

- **Share** posts the sheet to a chat channel — it arrives as an
  **Open ↗** chip anyone can tap. Note it posts immediately to the channel
  you pick.

![The share-to-channel picker](shot:patch-share)

- **Export** downloads the sheet as CSV, for mailing to an act's engineer
  or archiving with the show file.
