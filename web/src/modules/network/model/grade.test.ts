import { describe, expect, it } from 'vitest'
import { overallGrade } from './grade.ts'
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
