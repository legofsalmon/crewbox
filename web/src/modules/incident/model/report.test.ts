import { describe, expect, it } from 'vitest'
import type { Incident } from '@crewbox/shared'
import { reportFilename, showReportHtml } from './report.ts'

/**
 * The show report leaves the box and gets emailed, printed and filed. What
 * matters is that it is one honest self-contained file: nothing to fetch,
 * nothing that can execute, and the night in the order it happened.
 */

let seq = 0
const at = (h: number, m: number, day = 11) => new Date(2026, 7, day, h, m).getTime()

const entry = (over: Partial<Incident> = {}): Incident => ({
  id: `i-${++seq}`,
  seq,
  authorId: 'u1',
  authorName: 'Maya Quinn',
  kind: 'note',
  severity: 'note',
  body: 'Barrier moved back a metre',
  at: at(21, 0),
  loggedAt: at(21, 0),
  stage: 'Main Stage',
  actId: 'a1',
  actName: 'Night Bus',
  ...over,
})

const report = (entries: Incident[], eventName = 'Ashton Court 2026') =>
  showReportHtml({ eventName, entries, generatedAt: at(2, 0, 12) })

describe('the show report', () => {
  it('is a whole file with nothing to fetch', () => {
    const html = report([entry()])
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).not.toMatch(/<script|src=|href=/i)
  })

  it('reads forwards, unlike the pane', () => {
    // A log is read backwards while a show is running and forwards on the
    // Monday morning.
    const first = entry({ at: at(19, 30), body: 'Doors' })
    const second = entry({ at: at(21, 0), body: 'Show stop' })
    const html = report([second, first])
    expect(html.indexOf('Doors')).toBeLessThan(html.indexOf('Show stop'))
  })

  it('keeps a night together across midnight', () => {
    const html = report([entry({ at: at(23, 30, 11) }), entry({ at: at(0, 30, 12) })])
    // One heading, not two: both belong to the night of the 11th.
    expect(html.match(/<h2>/g)).toHaveLength(1)
  })

  it('says when an entry was written up well after the event', () => {
    const html = report([entry({ at: at(21, 0), loggedAt: at(21, 12) })])
    expect(html).toContain('12 min after the event')
  })

  it('stays quiet about a note written on the spot', () => {
    expect(report([entry({ at: at(21, 0), loggedAt: at(21, 0) })])).not.toContain('after the event')
  })

  it('prints a correction under what it corrects', () => {
    const original = entry({ body: 'Show stopped 21:04' })
    const html = report([original, entry({ body: 'Correction: 21:14', amends: original.id })])
    expect(html.indexOf('Show stopped 21:04')).toBeLessThan(html.indexOf('Correction: 21:14'))
    expect(html).toContain('class="correction"')
  })

  it('escapes what crew typed, including an act called &lt;script&gt;', () => {
    // The entries are free text from a phone and the file gets opened in a
    // browser by somebody who did not write it.
    const html = report([entry({ body: '<script>alert(1)</script>', actName: '"><b>' })])
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('counts the serious ones at the top', () => {
    const html = report([entry({ severity: 'serious' }), entry({ severity: 'issue' }), entry()])
    expect(html).toContain('3 entries')
    expect(html).toContain('1 serious')
  })

  it('says so plainly when nothing was logged', () => {
    expect(report([])).toContain('Nothing was logged')
  })

  it('names the file after the event and the night', () => {
    expect(reportFilename('Ashton Court 2026', at(2, 0, 12))).toBe(
      'ashton-court-2026-show-report-2026-08-11.html'
    )
    expect(reportFilename('', at(21, 0))).toBe('crewbox-show-report-2026-08-11.html')
  })
})
