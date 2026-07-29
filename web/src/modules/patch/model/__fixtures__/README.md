# Patch sheet fixtures

Two real festival master patch sheets, exported from Google Sheets and then
scrubbed: **the event, the stage and every act name are invented**. Nothing
else was touched — the layout, the sub-snake legend, the house input list,
the cell conventions and the free text are exactly as the crews keep them,
and that is the whole point of having them here.

| File                        | What it exercises                                                                                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `festival-master-patch.csv` | The layout the importer was first built against: two-tier header, sub-box tails in the grid, SPEC lines.                                                                                                                                   |
| `festival-day-sheet.csv`    | A second stage's export. A five-way sub-snake legend, per-act "Additional info" boxes with real text, a NO./ITEM table of kit wanted from the house, and bare single-letter sub-box refs (`H`) instead of the other sheet's `SB1-1` style. |

The second file was added after the first one turned out to be one file's
worth of evidence about a layout crews build by hand. It immediately found
two things being read and dropped — see `readActFooters` in
`../importFestival.ts`.

Keep it that way: when a new sheet turns up, scrub the names, add it here,
and let it argue with the parser.
