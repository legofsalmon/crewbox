import { describe, expect, it } from 'vitest'
import { auditFilename, buildAuditHtml } from './export.ts'
import type { AuditPayload, SeriesPoint } from './types.ts'

const payload: AuditPayload = {
  report: {
    generatedAt: Date.UTC(2026, 7, 8, 14, 30),
    networks: [
      {
        id: 'crew',
        label: 'Crew network',
        grade: 'ok',
        findings: [
          {
            id: 'crew-clients',
            label: 'Crew devices',
            state: 'info',
            detail: '12 connections open',
            series: { metric: 'crew.connections', key: '' },
          },
        ],
      },
      {
        id: 'lighting',
        label: 'Lighting network',
        grade: 'limited',
        findings: [
          {
            id: 'light-loss-4',
            label: 'Universe 4 frame loss',
            state: 'limited',
            detail: 'Universe 4 lost 2.3% of frames',
            fix: 'Check the switch port <duplex>',
            series: { metric: 'dmx.lossPct', key: '4' },
          },
        ],
      },
    ],
  },
  events: [
    {
      id: 'e1',
      at: Date.UTC(2026, 7, 8, 13, 40),
      network: 'lighting',
      kind: 'dmx.outage',
      key: '',
      detail: '3 universes dark',
    },
  ],
  probe: {
    id: 'r1',
    startedAt: 0,
    finishedAt: 1000,
    by: 'Colm',
    report: {
      probes: [
        {
          id: 'artnet-inventory',
          network: 'lighting',
          state: 'ok',
          sent: 'one ArtPoll broadcast to 255.255.255.255:6454',
          detail: '12 Art-Net nodes',
        },
      ],
    },
  },
  probeRunning: false,
}

const series = new Map<string, SeriesPoint[]>([
  [
    'dmx.lossPct 4',
    [
      [0, 0, 1, 2, 10],
      [60_000, 1, 2.3, 4, 10],
    ],
  ],
])

describe('buildAuditHtml', () => {
  const html = buildAuditHtml(payload, series, {
    eventName: 'Letissier',
    version: '0.10.1+abc',
    generatedAt: payload.report.generatedAt,
  })

  it('is a self-contained document with no external URLs', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).not.toMatch(/https?:\/\//)
    // No scripts that execute — the only <script> is inert JSON data.
    expect(html).not.toMatch(/<script(?![^>]*type="application\/json")/)
  })

  it('carries the findings, grades and fixes', () => {
    expect(html).toContain('Crew network')
    expect(html).toContain('Usable — fixes below')
    expect(html).toContain('Universe 4 lost 2.3% of frames')
    expect(html).toContain('Check the switch port')
  })

  it('draws the referenced series as an inline SVG', () => {
    expect(html).toContain('<svg')
    expect(html).toContain('stroke="#9a6600"')
  })

  it('lists events and the probe log with its verbatim sent line', () => {
    expect(html).toContain('3 universes dark')
    expect(html).toContain('sent: one ArtPoll broadcast to 255.255.255.255:6454')
  })

  it('escapes user-influenced text so the report can never inject markup', () => {
    expect(html).toContain('Check the switch port &lt;duplex&gt;')
    expect(html).not.toContain('<duplex>')
  })

  it('embeds the raw report JSON for the numbers, with < neutralised', () => {
    expect(html).toContain('id="crewbox-audit"')
    expect(html).not.toMatch(/id="crewbox-audit">[^<]*<[^/]/)
  })

  it('names the file by the report date', () => {
    expect(auditFilename(Date.UTC(2026, 7, 8))).toBe('crewbox-network-audit-2026-08-08.html')
  })
})
