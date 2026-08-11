---
title: Paste and import
section: Patch sheets
order: 20
blurb: Paste straight from Google Sheets, or import the whole festival master patch as a CSV.
---

# Paste and import

Most patches already exist somewhere — a Google Sheet the festival has kept
for years, a console export, last year's file. Crewbox meets them where they
are: paste a block straight into the grid, or import a CSV whole.

## Paste from Google Sheets

Copy a rectangle of cells in Google Sheets (or Excel), click the crewbox
grid cell where its top-left corner should land, and paste. The block fills
right and down from there:

- New channels are added automatically if the block runs past the bottom.
- Columns that don't fit the sheet are dropped — the toast says so:
  "Pasted 24 cells · added 3 channel(s) · 2 column(s) didn't fit".
- The whole paste is **one undo step** — `⌘Z` takes it all back.

This is the workhorse for "the stage manager just sent me three more rows".

## Import a CSV

**⇪ Import CSV** on the sheet list (or just **drop a `.csv` file onto the
sheet list page**) builds a new sheet from a spreadsheet export. Two shapes
are understood:

1. **A plain grid** — headers matched by meaning, one row per channel.
2. **A real festival master patch** — the shape these sheets actually have
   in the wild: a title row, a colour legend for the sub-snakes, a two-tier
   header where act names span their column groups, house inputs down the
   side. Crewbox recognises this and pulls out the acts, their set times,
   the house inputs, the sub-boxes with their colours, and the changeovers.

Importing a festival sheet is also how the box learns the day: the acts in
the file land on the [running order](/docs/schedule), so lighting, stage
management and the countdowns on every phone get them at the same moment
audio does. Import the same file twice — a second sheet for the same stage,
a re-import after a correction — and it reconciles with the day already
there rather than listing it again. Blank cells in the file leave a time
somebody fixed by hand alone.

The import toast is honest about what happened: how many channels and acts
came through, which columns it didn't recognise, and any disagreement
between the changeovers written in the sheet and the gaps the set times
imply.

> [!NOTE]
> Import creates a **new** sheet — it never merges into an existing one. To
> bring late changes into a live sheet, use paste.

## Getting data back out

**Export** on any sheet downloads it as CSV, readable by anything. What you
export is the grid as it stands — including everything derived from it
being live, so the file you send the PA company is never stale.

## If an import looks wrong

- **Columns missing** — check the toast; unrecognised headers are named
  there. Rename the column in the spreadsheet (Input, Description, Mic/DI,
  Stand are all understood, with common variants) and re-import.
- **Acts came in as one column** — the file lost its two-tier header
  (single-sheet CSV exports flatten merged cells). Export the master patch
  tab specifically, not the whole workbook.
- **Changeover warnings** — not an error. The sheet's changeovers disagree
  with its set times, and crewbox refuses to guess which is right —
  [the lineup page](/docs/patch-stage-and-lineup#changeovers) explains.
