import { sparklinePaths, SPARK_H, SPARK_W } from './sparkline.ts'
import type { AuditEvent, AuditPayload, SeriesPoint } from './types.ts'

/**
 * The self-contained HTML report — the thing you hand to venue IT.
 *
 * One file, zero JavaScript, zero external URLs: every chart is static SVG
 * built by the same sparkline geometry the live pane uses, and the raw
 * report JSON rides along in a <script type="application/json"> block for
 * anyone who wants the numbers. Safe to email, print, or archive per gig.
 *
 * Deliberately NOT theme-aware. The app's DOM follows the viewer's dark
 * mode (and theme.spec.ts guards it); this is a document, not the app, so
 * it carries a fixed light palette in its own inline <style>. Do not
 * "fix" it to use the app tokens — a printed report is not a themed pane.
 */

const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )

const GRADE_LABEL: Record<string, string> = {
  ok: 'Good for A/V',
  limited: 'Usable — fixes below',
  off: 'Not suitable right now',
  unknown: 'Not watched',
}

const STATE_WORD: Record<string, string> = {
  ok: 'Working',
  limited: 'Limited',
  off: 'Fault',
  info: 'Note',
}

const clock = (at: number): string => new Date(at).toTimeString().slice(0, 5)

/** Fixed light palette — a printed document, not a themed pane. */
const STYLE = `
  :root { --ink:#1a1a1a; --muted:#5a5a5a; --line:#d8d4cc; --paper:#fdfbf7;
          --ok:#1b7d4c; --warn:#9a6600; --bad:#c53a2a; }
  * { box-sizing:border-box; }
  body { font:15px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
         color:var(--ink); background:var(--paper); margin:0; padding:32px; }
  h1 { font-size:24px; margin:0 0 2px; }
  .meta { color:var(--muted); font-size:13px; margin-bottom:24px; }
  .net { border:1px solid var(--line); border-radius:10px; padding:16px; margin-bottom:16px; }
  .net h2 { font-size:18px; margin:0 0 10px; display:flex; justify-content:space-between; gap:12px; }
  .grade { font-size:13px; font-weight:700; }
  .grade.ok { color:var(--ok); } .grade.limited { color:var(--warn); }
  .grade.off { color:var(--bad); } .grade.unknown { color:var(--muted); }
  .finding { padding:8px 0; border-top:1px solid var(--line); display:flex; gap:10px; }
  .finding:first-of-type { border-top:0; }
  .dot { flex:0 0 auto; font-weight:700; }
  .dot.ok { color:var(--ok); } .dot.limited { color:var(--warn); }
  .dot.off { color:var(--bad); } .dot.info { color:var(--muted); }
  .flabel { font-weight:600; }
  .fdetail { color:var(--muted); }
  .ffix { color:var(--warn); }
  .fseries svg { vertical-align:middle; margin-left:8px; }
  .events td { padding:3px 12px 3px 0; vertical-align:top; }
  .events .t { color:var(--muted); white-space:nowrap; font-variant-numeric:tabular-nums; }
  .sent { font-family:ui-monospace,monospace; font-size:12px; color:var(--muted); }
  table { border-collapse:collapse; }
  h3 { font-size:15px; margin:24px 0 8px; }
`

/** A static sparkline SVG for the export (no classes — inline strokes). */
function chartSvg(points: SeriesPoint[]): string {
  const p = sparklinePaths(points)
  if (!p.d) return ''
  const band = p.bandD ? `<path d="${p.bandD}" fill="rgba(154,102,0,0.18)" stroke="none"/>` : ''
  // No xmlns: inline SVG inside an HTML5 document needs none, and it keeps
  // the report literally free of any http(s) reference.
  return (
    `<svg width="${SPARK_W}" height="${SPARK_H}" viewBox="${p.viewBox}">${band}` +
    `<path d="${p.d}" fill="none" stroke="#9a6600" stroke-width="1.5" ` +
    `stroke-linejoin="round" stroke-linecap="round"/></svg>`
  )
}

/** Build the report. `series` is keyed `metric key`, like the pane's map. */
export function buildAuditHtml(
  payload: AuditPayload,
  series: Map<string, SeriesPoint[]>,
  context: { eventName: string; version: string; generatedAt: number }
): string {
  const { report, events, probe } = payload
  const networks = report.networks
    .map((net) => {
      const findings = net.findings
        .map((f) => {
          const key = f.series ? `${f.series.metric} ${f.series.key}` : ''
          const chart = key && series.has(key) ? chartSvg(series.get(key)!) : ''
          return (
            `<div class="finding"><span class="dot ${f.state}">${STATE_WORD[f.state] ?? ''}</span>` +
            `<div><span class="flabel">${esc(f.label)}</span>` +
            (chart ? `<span class="fseries">${chart}</span>` : '') +
            `<div class="fdetail">${esc(f.detail)}</div>` +
            (f.fix ? `<div class="ffix">${esc(f.fix)}</div>` : '') +
            `</div></div>`
          )
        })
        .join('')
      return (
        `<div class="net"><h2>${esc(net.label)}` +
        `<span class="grade ${net.grade}">${GRADE_LABEL[net.grade] ?? net.grade}</span></h2>` +
        findings +
        `</div>`
      )
    })
    .join('')

  const eventRows = events
    .slice(0, 100)
    .map((e: AuditEvent) => `<tr><td class="t">${clock(e.at)}</td><td>${esc(e.detail)}</td></tr>`)
    .join('')

  const probeReport = probe?.report as
    { probes?: Array<{ detail: string; fix?: string; sent: string }> } | undefined
  const probeRows = (probeReport?.probes ?? [])
    .map(
      (p) =>
        `<div class="finding"><div><div>${esc(p.detail)}</div>` +
        (p.fix ? `<div class="ffix">${esc(p.fix)}</div>` : '') +
        `<div class="sent">sent: ${esc(p.sent)}</div></div></div>`
    )
    .join('')

  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Network audit — ${esc(context.eventName || 'Crewbox')}</title>` +
    `<style>${STYLE}</style></head><body>` +
    `<h1>Network audit</h1>` +
    `<div class="meta">${esc(context.eventName || 'Crewbox')} · generated ${new Date(context.generatedAt).toISOString()} · box ${esc(context.version)}</div>` +
    networks +
    (probeRows ? `<h3>Deep probe</h3><div class="net">${probeRows}</div>` : '') +
    (eventRows ? `<h3>Events</h3><table class="events">${eventRows}</table>` : '') +
    `<script type="application/json" id="crewbox-audit">${JSON.stringify(report).replace(/</g, '\\u003c')}</script>` +
    `</body></html>`
  )
}

/** crewbox-network-audit-2026-08-08.html — one report per gig. */
export function auditFilename(generatedAt: number): string {
  return `crewbox-network-audit-${new Date(generatedAt).toISOString().slice(0, 10)}.html`
}
