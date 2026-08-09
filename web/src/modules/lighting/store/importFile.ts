import type * as Y from 'yjs'
import { parseCsv } from '../../_shared/csv'
import { fixturesFromCsv } from '../model/importCsv'
import { parseMvr, type MvrFixture } from '../model/mvr'
import { fitPosition, isBar } from '../model/placement'
import {
  addFixtures,
  addPosition,
  removePosition,
  snapshotPlot,
  updatePosition,
  upsertFixtureType,
} from '../model/plotDoc'

/**
 * File import into a plot doc, shared by PlotView (Import button, drop zone)
 * and PlotSelector (drop a rig file before any plot exists). Returns the
 * summary line to show; throws with a readable message on an unreadable
 * file. The snapshot is taken from the doc at call time, so callers never
 * pass stale state.
 */
export async function importPlotFile(doc: Y.Doc, file: File): Promise<string> {
  if (file.name.toLowerCase().endsWith('.mvr')) {
    return importMvr(doc, new Uint8Array(await file.arrayBuffer()))
  }
  return importCsv(doc, await file.text())
}

/**
 * The selector imports into a plot it is about to navigate to, and the
 * summary has to survive that navigation — PlotView seeds its flash from
 * here on mount. Module scope, one shot, same precedent as chat's drafts.
 */
let pendingFlash: string | null = null
export const stashImportFlash = (message: string): void => {
  pendingFlash = message
}
export const takeImportFlash = (): string | null => {
  const message = pendingFlash
  pendingFlash = null
  return message
}

function importCsv(doc: Y.Doc, text: string): string {
  const snapshot = snapshotPlot(doc)
  const result = fixturesFromCsv(parseCsv(text), snapshot.customTypes)
  if (result.fixtures.length === 0) {
    return 'Nothing imported — no recognisable columns in that file.'
  }

  // Create any positions the file mentions that the plot doesn't have, so
  // fixtures land on the truss they name rather than in "No position".
  const byName = new Map(snapshot.positions.map((p) => [p.name.toLowerCase(), p.id]))
  for (const name of result.positionNames) {
    if (!byName.has(name.toLowerCase())) {
      byName.set(name.toLowerCase(), addPosition(doc, name))
    }
  }

  addFixtures(
    doc,
    result.fixtures.map(({ positionName, typeName, ...fixture }) => ({
      ...fixture,
      positionId: positionName ? (byName.get(positionName.toLowerCase()) ?? '') : '',
      // An unrecognised type name is kept as the mode text rather than
      // dropped, so the information survives even without a library entry.
      ...(typeName ? { mode: fixture.mode || typeName } : {}),
    }))
  )

  const skipped = result.skippedColumns.length
  return (
    `Imported ${result.fixtures.length} fixtures` +
    (skipped > 0
      ? ` · ${skipped} column${skipped === 1 ? '' : 's'} not recognised: ${result.skippedColumns.join(', ')}`
      : '')
  )
}

/**
 * MVR carries far more than a CSV: the fixture's own GDTF profile (so the
 * footprint is authoritative rather than guessed) and real coordinates,
 * which get fitted onto positions so the plot arrives placed.
 */
function importMvr(doc: Y.Doc, bytes: Uint8Array): string {
  const snapshot = snapshotPlot(doc)
  const result = parseMvr(bytes)
  if (result.fixtures.length === 0) {
    return 'Nothing imported — that MVR has no fixtures in it.'
  }

  for (const type of result.types) upsertFixtureType(doc, type)

  // A brand-new plot ships with one placeholder truss. Once a real rig
  // lands it's just an empty row in the list and a stray label on the
  // plan, so clear it — but only when it's demonstrably untouched.
  const placeholder =
    snapshot.positions.length === 1 && snapshot.fixtures.length === 0
      ? snapshot.positions[0]!.id
      : null

  const byLayer = new Map<string, MvrFixture[]>()
  for (const fixture of result.fixtures) {
    const list = byLayer.get(fixture.layer)
    if (list) list.push(fixture)
    else byLayer.set(fixture.layer, [fixture])
  }

  const existing = new Map(snapshot.positions.map((p) => [p.name.toLowerCase(), p.id]))
  const used = new Set<string>()

  for (const [layer, group] of byLayer) {
    // `order` and `residual` are placement output, not document state.
    const { order, residual, ...geometry } = fitPosition(group)
    let positionId = existing.get(layer.toLowerCase())
    if (!positionId) {
      positionId = addPosition(doc, layer)
      existing.set(layer.toLowerCase(), positionId)
    }
    used.add(positionId)
    // Real files group by role ("Spots", "Washes") as often as by bar, and
    // those fixtures sit across several trusses. Drawing one long line
    // through them would invent a truss that isn't there, so a scattered
    // group becomes a grouping with no bar — its fixtures still land at
    // their true coordinates.
    updatePosition(doc, positionId, {
      ...geometry,
      length: isBar({ ...geometry, order, residual }, group.length) ? geometry.length : 0,
    })

    // Unit numbers follow the order along the bar, so the plot and the
    // paperwork agree with what someone counting along the truss sees.
    addFixtures(
      doc,
      order.map((index, along) => {
        const fixture = group[index]!
        return {
          channel: fixture.channel,
          universe: fixture.universe,
          address: fixture.address,
          typeId: fixture.typeId,
          mode: fixture.mode,
          footprint: fixture.footprint,
          purpose: fixture.name,
          positionId,
          unit: fixture.unit || String(along + 1),
          x: fixture.x,
          y: fixture.y,
          z: fixture.z,
        }
      })
    )
  }

  // ...unless the import reused it, which happens whenever a layer is
  // named the same as the placeholder. Deleting it then would take the
  // fixtures' position out from under them.
  if (placeholder && !used.has(placeholder)) removePosition(doc, placeholder)

  return (
    `Imported ${result.fixtures.length} fixtures across ${byLayer.size} position${
      byLayer.size === 1 ? '' : 's'
    }` + (result.warnings.length > 0 ? ` · ${result.warnings.join(' · ')}` : '')
  )
}
