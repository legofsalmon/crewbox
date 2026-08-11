import { INCIDENT_KIND_LABELS, INCIDENT_SEVERITY_LABELS, type Incident } from '@crewbox/shared'
import { loggedLate, showDayOf, withCorrections } from './log.ts'

/**
 * The show report — the thing that gets emailed on the Monday.
 *
 * One self-contained HTML file: no JavaScript, no external URLs, prints
 * straight from a browser. Deliberately not theme-aware, for the same reason
 * the network audit's report isn't: this is a document that leaves the app,
 * and a document has one appearance. (See modules/network/model/export.ts —
 * same rule, same reasons, so do not "fix" this to use the app's tokens.)
 *
 * Oldest first, because a report is read forwards. The pane is newest first,
 * because a log is read backwards. Both are right for what they are.
 */

const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )

const clock = (at: number): string => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const STYLE = `
  :root { --ink:#1a1a1a; --muted:#5a5a5a; --line:#d8d4cc; --paper:#fdfbf7;
          --serious:#c53a2a; --issue:#9a6600; }
  * { box-sizing:border-box; }
  body { font:15px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
         color:var(--ink); background:var(--paper); margin:0; padding:32px; }
  h1 { font-size:24px; margin:0 0 2px; }
  h2 { font-size:17px; margin:28px 0 8px; padding-bottom:6px; border-bottom:1px solid var(--line); }
  .meta { color:var(--muted); font-size:13px; margin-bottom:8px; }
  .tally { font-size:13px; color:var(--muted); margin-bottom:20px; }
  .entry { border-left:3px solid var(--line); padding:8px 0 8px 12px; margin:0 0 12px; }
  .entry.issue { border-left-color:var(--issue); }
  .entry.serious { border-left-color:var(--serious); }
  .head { display:flex; flex-wrap:wrap; gap:8px; align-items:baseline; }
  .time { font-variant-numeric:tabular-nums; font-weight:700; }
  .kind { font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
  .where { font-size:13px; color:var(--muted); }
  .body { margin:4px 0 0; white-space:pre-wrap; }
  .by { font-size:12px; color:var(--muted); margin-top:4px; }
  .correction { margin:8px 0 0 16px; padding-left:10px; border-left:2px dotted var(--line); }
  .correction .body { font-size:14px; }
  .empty { color:var(--muted); font-style:italic; }
  @media print { body { padding:0; background:#fff; } h2 { break-after:avoid; }
                 .entry { break-inside:avoid; } }
`

export interface ShowReport {
  eventName: string
  entries: Incident[]
  generatedAt: number
}

/** One entry and its corrections, as the report renders them. */
function entryHtml(entry: Incident, corrections: Incident[]): string {
  const late = loggedLate(entry)
  const where = [entry.stage, entry.actName].filter(Boolean).join(' · ')
  return `<div class="entry ${entry.severity}">
    <div class="head">
      <span class="time">${clock(entry.at)}</span>
      <span class="kind">${esc(INCIDENT_KIND_LABELS[entry.kind])}${
        entry.severity === 'note' ? '' : ` — ${esc(INCIDENT_SEVERITY_LABELS[entry.severity])}`
      }</span>
      ${where ? `<span class="where">${esc(where)}</span>` : ''}
    </div>
    <p class="body">${esc(entry.body)}</p>
    <p class="by">${entry.authorName ? `Logged by ${esc(entry.authorName)}` : 'Logged by a crew member'}${
      // Said plainly, because a note written twelve minutes later is a
      // different kind of evidence from one written at the time.
      late >= 2 ? `, ${late} min after the event` : ''
    }</p>
    ${corrections
      .map(
        (c) => `<div class="correction">
      <p class="body">${esc(c.body)}</p>
      <p class="by">Correction at ${clock(c.at)}${
        c.authorName ? ` by ${esc(c.authorName)}` : ''
      }</p>
    </div>`
      )
      .join('')}
  </div>`
}

/**
 * Build the report. `entries` is everything the pane holds; this arranges
 * them by night and by clock, with corrections attached to their originals.
 */
export function showReportHtml({ eventName, entries, generatedAt }: ShowReport): string {
  const lines = withCorrections(entries)
  const days = new Map<string, typeof lines>()
  // Oldest first: a report is read forwards, unlike the pane.
  for (const line of [...lines].reverse()) {
    const day = showDayOf(line.entry.at)
    days.set(day, [...(days.get(day) ?? []), line])
  }

  const serious = entries.filter((e) => e.severity === 'serious').length
  const issues = entries.filter((e) => e.severity === 'issue').length
  const title = `${eventName || 'Crewbox'} — show report`

  const body = [...days.entries()]
    .map(
      ([day, dayLines]) =>
        `<h2>${esc(new Date(`${day}T12:00:00`).toDateString())}</h2>` +
        dayLines.map((l) => entryHtml(l.entry, l.corrections)).join('')
    )
    .join('')

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style></head>
<body>
  <h1>${esc(title)}</h1>
  <p class="meta">Generated ${esc(new Date(generatedAt).toLocaleString())}</p>
  <p class="tally">${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}${
    serious ? ` · ${serious} serious` : ''
  }${issues ? ` · ${issues} affecting the show` : ''}</p>
  ${body || '<p class="empty">Nothing was logged.</p>'}
</body></html>`
}

/** Filename for the download, dated so a week of them sorts. */
export const reportFilename = (eventName: string, generatedAt: number): string => {
  const slug = (eventName || 'crewbox').toLowerCase().replace(/[^a-z0-9]+/g, '-')
  return `${slug.replace(/^-|-$/g, '') || 'crewbox'}-show-report-${showDayOf(generatedAt)}.html`
}
