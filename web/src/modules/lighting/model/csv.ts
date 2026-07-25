import { toCsv } from '../../_shared/csv'
import { formatAddress } from './addressing'
import { findFixtureType } from './fixtures'
import { FIXTURE_STATUS_LABELS, type PlotSnapshot } from './types'

/**
 * Export a plot as CSV, using column names the rest of the industry already
 * reads — Position, Unit #, Channel, Address, Type, Purpose. The same
 * headers the importer matches, so a plot round-trips.
 */
export const plotToCsv = (plot: PlotSnapshot): string => {
  const positionName = new Map(plot.positions.map((position) => [position.id, position.name]))

  const rows: string[][] = [
    [
      'Position',
      'Unit #',
      'Channel',
      'Universe',
      'Address',
      'Type',
      'Mode',
      'Footprint',
      'Purpose',
      'Circuit',
      'Watts',
      'Weight',
      'Status',
      'Notes',
    ],
  ]

  for (const fixture of plot.fixtures) {
    const type = findFixtureType(fixture.typeId, plot.customTypes)
    rows.push([
      positionName.get(fixture.positionId) ?? '',
      fixture.unit,
      fixture.channel,
      String(fixture.universe),
      fixture.address > 0 ? String(fixture.address) : '',
      type?.name ?? '',
      fixture.mode,
      String(fixture.footprint),
      fixture.purpose,
      fixture.circuit,
      fixture.watts === null ? '' : String(fixture.watts),
      fixture.weight === null ? '' : String(fixture.weight),
      FIXTURE_STATUS_LABELS[fixture.status],
      fixture.notes,
    ])
  }

  return toCsv(rows)
}

/** Filename like `Main_Stage_Rig_Glastonbury_2026-06-24.csv`. */
export const plotCsvFilename = (plot: PlotSnapshot): string => {
  const clean = (value: string, fallback: string) =>
    (value.trim() || fallback).replace(/[^a-zA-Z0-9-]+/g, '_')
  const title = clean(plot.meta.title, 'plot')
  const venue = clean(plot.meta.venue, 'venue')
  const date = plot.meta.date || 'undated'
  return `${title}_${venue}_${date}.csv`
}

/** One-line summary for sharing into chat. */
export const plotSummary = (plot: PlotSnapshot): string => {
  const total = plot.fixtures.length
  const faults = plot.fixtures.filter((fixture) => fixture.status === 'fault').length
  const outstanding = plot.fixtures.filter((fixture) => fixture.status === 'todo').length
  const parts = [`${total} fixture${total === 1 ? '' : 's'}`]
  if (outstanding > 0) parts.push(`${outstanding} to do`)
  if (faults > 0) parts.push(`${faults} fault${faults === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

/** Formatted address for display, e.g. `2/25`. */
export { formatAddress }
