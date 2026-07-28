import { describe, expect, it } from 'vitest'
import { parseCsv } from '../../_shared/csv'
import { fixturesFromCsv } from './importCsv'
import { plotToCsv } from './csv'
import type { FixtureType, PlotSnapshot } from './types'
import { emptyFixture } from './types'

const noCustomTypes: FixtureType[] = []

describe('CSV import', () => {
  it('reads a Lightwright-style export', () => {
    const csv = [
      'Channel,Position,Unit #,Purpose,Type,Universe,Address,Circuit Name,Wattage',
      '101,Upstage Truss,1,DS Wash,LED PAR (generic),1,1,A12,150',
      '102,Upstage Truss,2,DS Wash,LED PAR (generic),1,5,A13,150',
    ].join('\n')

    const result = fixturesFromCsv(parseCsv(csv), noCustomTypes)

    expect(result.fixtures).toHaveLength(2)
    expect(result.fixtures[0]).toMatchObject({
      channel: '101',
      positionName: 'Upstage Truss',
      unit: '1',
      purpose: 'DS Wash',
      typeId: 'led-par',
      universe: 1,
      address: 1,
      circuit: 'A12',
      watts: 150,
    })
    expect(result.positionNames).toEqual(['Upstage Truss'])
    expect(result.skippedColumns).toEqual([])
  })

  it('reads a console export with absolute addresses', () => {
    const csv = [
      'Chan,Address,Type,Label',
      '1,537,Clay Paky Sharpy,Beam SL',
      '2,553,,Beam SR',
    ].join('\n')

    const result = fixturesFromCsv(parseCsv(csv), noCustomTypes)

    // 537 is universe 2, address 25 — the notation consoles export.
    expect(result.fixtures[0]).toMatchObject({
      channel: '1',
      universe: 2,
      address: 25,
      typeId: 'claypaky-sharpy',
      purpose: 'Beam SL',
    })
    expect(result.fixtures[1]).toMatchObject({ universe: 2, address: 41 })
  })

  it('reads universe-qualified addresses', () => {
    const result = fixturesFromCsv(
      parseCsv(['Channel,Patch', '1,2/25', '2,3.100'].join('\n')),
      noCustomTypes
    )
    expect(result.fixtures[0]).toMatchObject({ universe: 2, address: 25 })
    expect(result.fixtures[1]).toMatchObject({ universe: 3, address: 100 })
  })

  it('lets an explicit universe column win over the address notation', () => {
    // Some exports carry a bare in-universe address alongside a universe
    // column; reading the address as absolute would silently move fixtures.
    const result = fixturesFromCsv(
      parseCsv(['Channel,Universe,Address', '1,4,25'].join('\n')),
      noCustomTypes
    )
    expect(result.fixtures[0]).toMatchObject({ universe: 4, address: 25 })
  })

  it('skips title rows above the real header', () => {
    const csv = [
      'Glastonbury 2026 — Main Stage',
      'Generated 24/06/2026',
      '',
      'Channel,Position,Address,Purpose',
      '1,Truss 1,1,Wash',
    ].join('\n')

    const result = fixturesFromCsv(parseCsv(csv), noCustomTypes)
    expect(result.fixtures).toHaveLength(1)
    expect(result.fixtures[0]).toMatchObject({ channel: '1', purpose: 'Wash' })
  })

  it('reports columns it could not place rather than dropping them silently', () => {
    const result = fixturesFromCsv(
      parseCsv(['Channel,Address,Gel,Gobo', '1,1,L201,Breakup'].join('\n')),
      noCustomTypes
    )
    expect(result.skippedColumns).toEqual(['Gel', 'Gobo'])
  })

  it('does not mistake a circuit column for a unit number', () => {
    // 'Circuit #' and 'Unit #' both normalise close to a bare '#'.
    const result = fixturesFromCsv(
      parseCsv(['Channel,Unit #,Circuit #', '1,7,A12'].join('\n')),
      noCustomTypes
    )
    expect(result.fixtures[0]).toMatchObject({ unit: '7', circuit: 'A12' })
  })

  it('matches a type the plot already defines instead of duplicating it', () => {
    const custom: FixtureType[] = [
      { id: 'house-1', name: 'House Wash 4ch', modes: [{ name: 'Standard', footprint: 4 }] },
    ]
    const result = fixturesFromCsv(
      parseCsv(['Channel,Type', '1,house wash 4ch'].join('\n')),
      custom
    )
    expect(result.fixtures[0]).toMatchObject({ typeId: 'house-1' })
    expect(result.fixtures[0]!.typeName).toBeUndefined()
  })

  it('keeps an unknown type name for the caller to create', () => {
    const result = fixturesFromCsv(
      parseCsv(['Channel,Type', '1,Ayrton Perseo'].join('\n')),
      noCustomTypes
    )
    expect(result.fixtures[0]!.typeName).toBe('Ayrton Perseo')
    expect(result.fixtures[0]!.typeId).toBeUndefined()
  })

  it('returns nothing for a file with no recognisable headers', () => {
    const result = fixturesFromCsv(parseCsv('some,random,text\n1,2,3'), noCustomTypes)
    expect(result.fixtures).toEqual([])
  })
})

describe('CSV export', () => {
  it('round-trips through the importer', () => {
    const plot: PlotSnapshot = {
      meta: { title: 'Main Stage', venue: 'Worthy Farm', date: '2026-06-24', notes: '' },
      positions: [
        {
          id: 'p1',
          name: 'Upstage Truss',
          kind: 'truss',
          x: 0,
          y: 6,
          z: 6,
          length: 12,
          rotation: 0,
        },
      ],
      fixtures: [
        {
          ...emptyFixture(),
          id: 'f1',
          channel: '101',
          universe: 2,
          address: 25,
          typeId: 'claypaky-sharpy',
          footprint: 16,
          purpose: 'Beam SL',
          positionId: 'p1',
          unit: '1',
          circuit: 'A12',
          watts: 189,
          status: 'ok',
        },
      ],
      customTypes: [],
    }

    const reimported = fixturesFromCsv(parseCsv(plotToCsv(plot)), [])

    expect(reimported.fixtures[0]).toMatchObject({
      channel: '101',
      universe: 2,
      address: 25,
      typeId: 'claypaky-sharpy',
      footprint: 16,
      purpose: 'Beam SL',
      positionName: 'Upstage Truss',
      unit: '1',
      circuit: 'A12',
      watts: 189,
    })
  })
})
