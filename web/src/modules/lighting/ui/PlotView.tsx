import { useEffect, useMemo, useState } from 'react'
import DrawerButton from '../../../shell/DrawerButton.tsx'
import { registerShortcut } from '../../../shell/keys.ts'
import { useStore } from '../../../store.ts'
import { parseCsv } from '../../_shared/csv'
import { useDraft } from '../../_shared/ui/useDraft'
import { plotCsvFilename, plotSummary, plotToCsv } from '../model/csv'
import { fixturesFromCsv } from '../model/importCsv'
import { parseMvr, type MvrFixture } from '../model/mvr'
import { fitPosition } from '../model/placement'
import {
  addFixture,
  addFixtures,
  upsertFixtureType,
  addPosition,
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
import PlotPlan from './PlotPlan'
import PositionManager from './PositionManager'
import styles from './PlotView.module.scss'

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

export default function PlotView({ plotId, onClose }: { plotId: string; onClose: () => void }) {
  const { doc, snapshot, loaded, undoManager } = usePlot(plotId)
  const issues = usePlotIssues(snapshot)
  const [tab, setTab] = useState<'fixtures' | 'plan'>('fixtures')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showPositions, setShowPositions] = useState(false)
  const [showShare, setShowShare] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)

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

    const byLayer = new Map<string, MvrFixture[]>()
    for (const fixture of result.fixtures) {
      const list = byLayer.get(fixture.layer)
      if (list) list.push(fixture)
      else byLayer.set(fixture.layer, [fixture])
    }

    const existing = new Map(snapshot.positions.map((p) => [p.name.toLowerCase(), p.id]))

    for (const [layer, group] of byLayer) {
      // `order` is placement output, not document state — don't write it in.
      const { order, ...geometry } = fitPosition(group)
      let positionId = existing.get(layer.toLowerCase())
      if (!positionId) {
        positionId = addPosition(doc, layer)
        existing.set(layer.toLowerCase(), positionId)
      }
      updatePosition(doc, positionId, geometry)

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
          }
        })
      )
    }

    setFlash(
      `Imported ${result.fixtures.length} fixtures across ${byLayer.size} position${
        byLayer.size === 1 ? '' : 's'
      }` + (result.warnings.length > 0 ? ` · ${result.warnings.join(' · ')}` : '')
    )
  }

  const importFile = async (file: File) => {
    try {
      if (file.name.toLowerCase().endsWith('.mvr')) await importMvr(file)
      else await importCsv(file)
    } catch (error) {
      setFlash(`Import failed: ${error instanceof Error ? error.message : 'unreadable file'}`)
    }
  }

  return (
    <div className={styles.view}>
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
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'fixtures'}
            className={`${styles.tab} ${tab === 'fixtures' ? styles.tabActive : ''}`}
            onClick={() => setTab('fixtures')}
          >
            Fixtures
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'plan'}
            className={`${styles.tab} ${tab === 'plan' ? styles.tabActive : ''}`}
            onClick={() => setTab('plan')}
          >
            Plot
          </button>
        </div>

        <div className={styles.actions}>
          <button type="button" className={styles.action} onClick={() => setShowPositions(true)}>
            Positions
          </button>
          <button type="button" className={styles.action} onClick={() => addFixture(doc)}>
            + Fixture
          </button>
          <label className={styles.action}>
            Import
            <input
              type="file"
              accept=".csv,.mvr,text/csv"
              className={styles.fileInput}
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

      {flash && (
        <p className={styles.flash} role="status">
          {flash}
        </p>
      )}

      {tab === 'fixtures' ? (
        <FixtureList
          doc={doc}
          snapshot={snapshot}
          issues={issues}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      ) : (
        <PlotPlan
          doc={doc}
          snapshot={snapshot}
          issues={issues}
          selectedId={selectedId}
          onSelect={(id) => {
            setSelectedId(id)
            setTab('fixtures')
          }}
        />
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
    </div>
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
