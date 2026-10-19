import { describe, expect, it } from 'vitest'
import type { Department, User } from '@crewbox/shared'
import { crewByDepartment } from '../src/lib/departments.ts'

const person = (id: string, name: string, departmentId?: string): User => ({
  id,
  name,
  role: 'member',
  ...(departmentId ? { departmentId } : {}),
  createdAt: 0,
})

const departments: Record<string, Department> = {
  lx: { id: 'lx', name: 'Lighting', createdAt: 0 },
  snd: { id: 'snd', name: 'Sound', createdAt: 0 },
}

describe('the crew list by department', () => {
  it('groups A to Z with the people in none last, online first within each', () => {
    const groups = crewByDepartment(
      [
        person('1', 'Zoe', 'snd'),
        person('2', 'Ann', 'lx'),
        person('3', 'Bob', 'lx'),
        person('4', 'Cat'),
      ],
      departments,
      { '3': true }
    )
    expect(groups.map((g) => [g.name, g.people.map((p) => p.name)])).toEqual([
      ['Lighting', ['Bob', 'Ann']],
      ['Sound', ['Zoe']],
      [null, ['Cat']],
    ])
  })

  it('counts somebody whose department has just gone as in none', () => {
    const groups = crewByDepartment([person('1', 'Ann', 'gone')], departments, {})
    expect(groups).toEqual([{ id: null, name: null, people: [person('1', 'Ann', 'gone')] }])
  })
})
