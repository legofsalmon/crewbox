import { describe, expect, it } from 'vitest'
import { overallGrade, seriesWanted } from './grade.ts'
import type { AuditReport, NetworkGrade } from './types.ts'

const report = (...grades: NetworkGrade[]): AuditReport => ({
  generatedAt: 0,
  networks: grades.map((grade, i) => ({
    id: (['crew', 'lighting', 'media'] as const)[i]!,
    label: '',
    grade,
    findings: [],
  })),
})

describe('overallGrade', () => {
  it('is the worst watched network', () => {
    expect(overallGrade(report('ok', 'limited', 'ok'))).toBe('limited')
    expect(overallGrade(report('ok', 'off', 'limited'))).toBe('off')
  })

  it('unknown networks never drag the verdict down', () => {
    expect(overallGrade(report('ok', 'unknown', 'unknown'))).toBe('ok')
  })

  it('watching nothing at all is unknown, not ok', () => {
    expect(overallGrade(report('unknown', 'unknown', 'unknown'))).toBe('unknown')
  })
})

describe('which series the pane fetches', () => {
  const network = (findings: Array<{ series?: { metric: string; key: string } }>) =>
    ({
      id: 'crew',
      label: 'Crew',
      grade: 'ok',
      findings: findings.map((f, i) => ({
        id: `f${i}`,
        severity: 'info',
        title: 't',
        detail: 'd',
        ...f,
      })),
    }) as unknown as AuditReport['networks'][number]

  it('asks for each one once, however many findings cite it', () => {
    // Two findings on one network routinely reference the same series — a
    // loss figure and the latency beside it — and every duplicate was a
    // second identical query against the box's rollups, every ten seconds,
    // for as long as somebody had the pane open.
    const report = {
      generatedAt: 0,
      networks: [
        network([
          { series: { metric: 'rtt', key: 'crew' } },
          { series: { metric: 'rtt', key: 'crew' } },
        ]),
        network([
          { series: { metric: 'rtt', key: 'crew' } },
          { series: { metric: 'loss', key: 'crew' } },
        ]),
      ],
    } as AuditReport
    expect(seriesWanted(report)).toEqual([
      { metric: 'rtt', key: 'crew' },
      { metric: 'loss', key: 'crew' },
    ])
  })

  it('keeps the same metric on different networks apart', () => {
    const report = {
      generatedAt: 0,
      networks: [
        network([{ series: { metric: 'rtt', key: 'crew' } }]),
        network([{ series: { metric: 'rtt', key: 'lighting' } }]),
      ],
    } as AuditReport
    expect(seriesWanted(report)).toHaveLength(2)
  })

  it('skips findings with no evidence to draw', () => {
    const report = {
      generatedAt: 0,
      networks: [network([{}, { series: { metric: 'rtt', key: 'crew' } }])],
    } as AuditReport
    expect(seriesWanted(report)).toEqual([{ metric: 'rtt', key: 'crew' }])
  })
})
