import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import DrawerButton from '../../../shell/DrawerButton.tsx'
import { useFileDrop } from '../../../lib/useFileDrop.ts'
import { registerShortcut } from '../../../shell/keys.ts'
import { useStore } from '../../../store.ts'
import { parseCsv } from '../../_shared/csv'
import { useDraft } from '../../_shared/ui/useDraft'
import { plotCsvFilename, plotSummary, plotToCsv } from '../model/csv'
import { fixturesFromCsv } from '../model/importCsv'
import { parseMvr, type MvrFixture } from '../model/mvr'
import { fitPosition, isBar } from '../model/placement'
import {
  addFixture,
  addFixtures,
  upsertFixtureType,
  addPosition,
  removePosition,
  setPlotMeta,
  updatePosition,
} from '../model/plotDoc'
import { DMX_UNIVERSE_SIZE } from '../model/types'
import {
  usePlot,
  usePlotIssues,
  usePlotPeers,
  usePlotRemotePeers,
  useSyncStatus,
} from '../store/hooks'
import FixtureList from './FixtureList'
import LiveBar from './LiveBar'
import Plot3D from './Plot3D'
import PlotElevation from './PlotElevation'
import PlotPlan from './PlotPlan'
import PositionManager from './PositionManager'
import styles from './PlotView.module.scss'

/**
 * The four ways to look at a plot.
 *
 * Fixtures is the paperwork and stays the landing tab — it is what someone
 * opens a plot to read. The three drawings answer different questions: the
 * plan is "which one is that", the front is "how high is it", and the 3D is
 * "does that read as a rig at all".
 */
type PlotTab = 'fixtures' | 'plan' | 'front' | '3d'

const TABS: Array<{ id: PlotTab; label: string }> = [
  { id: 'fixtures', label: 'Fixtures' },
  { id: 'plan', label: 'Plan' },
  { id: 'front', label: 'Front' },
  { id: '3d', label: '3D' },
]

const download = (filename: string, text: string) => {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

function PresenceAvatars({ plotId }: { plotId: string }) {
  const peers = usePlotRemotePeers(plotId)
  if (peers.length === 0) return null
  return (
    <span
      className={styles.avatars}
      aria-label={`Also here: ${peers.map((p) => p.name).join(', ')}`}
    >
      {peers.slice(0, 5).map((peer) => (
        <span
          key={peer.clientId}
          className={styles.avatar}
          style={{ backgroundColor: peer.color }}
          title={peer.name}
        >
          {peer.name.charAt(0).toUpperCase()}
        </span>
      ))}
      {peers.length > 5 && <span className={styles.avatarOverflow}>+{peers.length - 5}</span>}
    </span>
  )
}

function SyncChip({ plotId }: { plotId: string }) {
  const status = useSyncStatus()
  const peers = usePlotPeers(plotId)
  const label =
    status === 'off'
      ? 'Local only'
      : status === 'connecting'
        ? 'Connecting…'
        : peers > 1
          ? `${peers} devices`
          : 'Synced'
  return (
    <span className={`${styles.chip} ${styles[`chip-${status}`]}`} title="Sync status">
      {label}
    </span>
  )
}

/**
 * The whole plot view accepts a dropped CSV or MVR.
 *
 * A component rather than hooks inside PlotView, because PlotView returns
 * early while a plot is still opening — hooks after that early return would
 * run in a different order between renders.
 */
function PlotDropZone({
  importing,
  onFiles,
  onReject,
  children,
}: {
  importing: boolean
  onFiles: (files: File[]) => void
  onReject: (files: File[]) => void
  children: ReactNode
}) {
  const accept = useCallback((file: File) => /\.(csv|mvr)$/i.test(file.name), [])
  // Disabled mid-import so a second drop can't interleave with a parse
  // already chewing through a 40 MB venue file.
  const drop = useFileDrop(onFiles, { disabled: importing, accept, onReject })
  return (
    <div className={`${styles.view} ${drop.over ? styles.dropping : ''}`} {...drop.handlers}>
      {drop.over && <div className={styles.dropVeil}>Drop a CSV or MVR to import fixtures</div>}
      {children}
    </div>
  )
}

export default function PlotView({ plotId, onClose }: { plotId: string; onClose: () => void }) {
  const { doc, snapshot, loaded, undoManager } = usePlot(plotId)
  const issues = usePlotIssues(snapshot)
  const [tab, setTab] = useState<PlotTab>('fixtures')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showPositions, setShowPositions] = useState(false)
  const [showShare, setShowShare] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  // Levels are the expensive half and off by default: most of the value is in
  // "is it arriving and does the patch match", which needs none of them.
  const [liveLevels, setLiveLevels] = useState(false)

  const title = useDraft(snapshot?.meta.title ?? '', (next) => {
    if (doc) setPlotMeta(doc, 'title', next)
  })

  useEffect(() => {
    if (!undoManager) return
    // Leave in-progress text edits to the browser's own undo — the doc-level
    // shortcut would otherwise swallow a half-typed purpose.
    const undoableTarget = (e: KeyboardEvent) =>
      !(e.target as HTMLElement | null)?.closest('[data-dirty="true"]')
    const offs = [
      registerShortcut({
        key: 'z',
        mod: true,
        when: undoableTarget,
        handler: () => undoManager.undo(),
      }),
      registerShortcut({
        key: 'z',
        mod: true,
        shift: true,
        when: undoableTarget,
        handler: () => undoManager.redo(),
      }),
    ]
    return () => offs.forEach((off) => off())
  }, [undoManager])

  useEffect(() => {
    if (!flash) return
    const timer = setTimeout(() => setFlash(null), 5000)
    return () => clearTimeout(timer)
  }, [flash])

  const universeLine = useMemo(
    () => issues.usage.map((u) => `U${u.universe}: ${u.used}/${DMX_UNIVERSE_SIZE}`).join(' · '),
    [issues.usage]
  )

  if (!doc || !snapshot) {
    return <div className={styles.loading}>{loaded ? 'Plot not found.' : 'Opening plot…'}</div>
  }

  const importCsv = async (file: File) => {
    const result = fixturesFromCsv(parseCsv(await file.text()), snapshot.customTypes)
    if (result.fixtures.length === 0) {
      setFlash('Nothing imported — no recognisable columns in that file.')
      return
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
    setFlash(
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
  const importMvr = async (file: File) => {
    const result = parseMvr(new Uint8Array(await file.arrayBuffer()))
    if (result.fixtures.length === 0) {
      setFlash('Nothing imported — that MVR has no fixtures in it.')
      return
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

    setFlash(
      `Imported ${result.fixtures.length} fixtures across ${byLayer.size} position${
        byLayer.size === 1 ? '' : 's'
      }` + (result.warnings.length > 0 ? ` · ${result.warnings.join(' · ')}` : '')
    )
  }

  const showInList = (id: string) => {
    setSelectedId(id)
    setTab('fixtures')
  }

  const importFile = async (file: File) => {
    // A festival MVR is tens of megabytes and takes seconds to inflate and
    // parse, all of it on the main thread. Say so rather than looking hung.
    setImporting(true)
    setFlash(`Reading ${file.name}…`)
    // Yield twice so the flash actually paints before the parse blocks.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    try {
      if (file.name.toLowerCase().endsWith('.mvr')) await importMvr(file)
      else await importCsv(file)
    } catch (error) {
      setFlash(`Import failed: ${error instanceof Error ? error.message : 'unreadable file'}`)
    } finally {
      setImporting(false)
    }
  }

  return (
    <PlotDropZone
      importing={importing}
      onFiles={(files) => {
        // Sequential, not parallel: an MVR parse blocks the main thread for
        // seconds, and two at once would freeze the tab showing nothing.
        void (async () => {
          for (const file of files) await importFile(file)
        })()
      }}
      onReject={(files) => setFlash(`${files[0].name} isn’t a CSV or MVR`)}
    >
      <header className={styles.head}>
        <DrawerButton />
        <button type="button" className={styles.back} onClick={onClose} aria-label="All plots">
          ‹
        </button>
        <input className={styles.title} aria-label="Plot title" {...title.inputProps} />
        <SyncChip plotId={plotId} />
        <PresenceAvatars plotId={plotId} />
      </header>

      <div className={styles.toolbar}>
        <div className={styles.tabs} role="tablist">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              className={`${styles.tab} ${tab === entry.id ? styles.tabActive : ''}`}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <div className={styles.actions}>
          <button type="button" className={styles.action} onClick={() => setShowPositions(true)}>
            Positions
          </button>
          <button type="button" className={styles.action} onClick={() => addFixture(doc)}>
            + Fixture
          </button>
          <label className={`${styles.action} ${importing ? styles.actionBusy : ''}`}>
            {importing ? 'Reading…' : 'Import'}
            <input
              type="file"
              accept=".csv,.mvr,text/csv"
              className={styles.fileInput}
              disabled={importing}
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void importFile(file)
                e.target.value = ''
              }}
            />
          </label>
          <button
            type="button"
            className={styles.action}
            onClick={() => download(plotCsvFilename(snapshot), plotToCsv(snapshot))}
          >
            Export
          </button>
          <button type="button" className={styles.action} onClick={() => setShowShare(true)}>
            Share
          </button>
        </div>
      </div>

      <div className={styles.summary}>
        <span>
          {snapshot.fixtures.length} fixture{snapshot.fixtures.length === 1 ? '' : 's'}
        </span>
        {universeLine && <span className={styles.universes}>{universeLine}</span>}
        {issues.affectedCount > 0 && (
          <span className={styles.problems} role="status">
            ⚠ {issues.affectedCount} addressing problem
            {issues.affectedCount === 1 ? '' : 's'}
          </span>
        )}
      </div>

      <LiveBar
        snapshot={snapshot}
        levels={liveLevels}
        onToggleLevels={() => setLiveLevels((on) => !on)}
      />

      {flash && (
        <p className={styles.flash} role="status">
          {flash}
        </p>
      )}

      {/* Picking a fixture in any drawing takes you to its row: the drawing
          says which one, the list says what it is patched to. */}
      {tab === 'fixtures' && (
        <FixtureList
          doc={doc}
          snapshot={snapshot}
          issues={issues}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      )}
      {tab === 'plan' && (
        <PlotPlan
          doc={doc}
          snapshot={snapshot}
          issues={issues}
          selectedId={selectedId}
          onSelect={showInList}
        />
      )}
      {tab === 'front' && (
        <PlotElevation
          snapshot={snapshot}
          issues={issues}
          selectedId={selectedId}
          onSelect={showInList}
        />
      )}
      {tab === '3d' && (
        <Plot3D snapshot={snapshot} issues={issues} selectedId={selectedId} onSelect={showInList} />
      )}

      {showPositions && (
        <PositionManager doc={doc} snapshot={snapshot} onClose={() => setShowPositions(false)} />
      )}

      {showShare && (
        <ShareMenu
          summary={`${snapshot.meta.title} — ${plotSummary(snapshot)}`}
          plotId={plotId}
          onShared={(channelName) => {
            setFlash(`Plot link posted in #${channelName}`)
            setShowShare(false)
          }}
          onClose={() => setShowShare(false)}
        />
      )}
    </PlotDropZone>
  )
}

/** Post a deep link to the plot into a chat channel. */
function ShareMenu({
  summary,
  plotId,
  onShared,
  onClose,
}: {
  summary: string
  plotId: string
  onShared: (channelName: string) => void
  onClose: () => void
}) {
  const channels = useStore((s) => s.channels)
  const sendMessage = useStore((s) => s.sendMessage)
  const publicChannels = Object.values(channels)
    .filter((c) => c.kind === 'public' && !c.retired)
    .sort((a, b) => a.createdAt - b.createdAt)

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={styles.shareMenu}
        role="dialog"
        aria-label="Share plot to a channel"
        onClick={(e) => e.stopPropagation()}
      >
        <p className={styles.shareTitle}>Share to channel</p>
        {publicChannels.map((channel) => (
          <button
            key={channel.id}
            type="button"
            className={styles.shareChannel}
            onClick={() => {
              sendMessage(channel.id, `💡 ${summary} — /m/lighting/plot/${plotId}`)
              onShared(channel.name)
            }}
          >
            #{channel.name}
          </button>
        ))}
      </div>
    </div>
  )
}
