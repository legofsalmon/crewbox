import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import DrawerButton from '../../../shell/DrawerButton.tsx'
import { deliveredNote, deliverText, type Delivered } from '../../../lib/download.ts'
import { useFileDrop } from '../../../lib/useFileDrop.ts'
import { documentUndoTarget, registerShortcut } from '../../../shell/keys.ts'
import { useStore } from '../../../store.ts'
import { useDraft } from '../../_shared/ui/useDraft'
import { plotCsvFilename, plotSummary, plotToCsv } from '../model/csv'
import { addFixture, setPlotMeta } from '../model/plotDoc'
import { DMX_UNIVERSE_SIZE } from '../model/types'
import { importPlotFile, takeImportFlash } from '../store/importFile'
import {
  useDocMissing,
  usePlot,
  usePlotIssues,
  usePlotPeers,
  usePlotRemotePeers,
  useSyncStatus,
} from '../store/hooks'
import FixtureList from './FixtureList'
import LiveBar from './LiveBar'
import FixtureChannels from './FixtureChannels'
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

const download = (filename: string, text: string): Promise<Delivered> =>
  deliverText(filename, 'text/csv;charset=utf-8', text)

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
  rootRef,
  children,
}: {
  importing: boolean
  onFiles: (files: File[]) => void
  onReject: (files: File[]) => void
  /** The view's own subtree, for scoping its keyboard shortcuts to it. */
  rootRef: RefObject<HTMLDivElement | null>
  children: ReactNode
}) {
  const accept = useCallback((file: File) => /\.(csv|mvr)$/i.test(file.name), [])
  // Disabled mid-import so a second drop can't interleave with a parse
  // already chewing through a 40 MB venue file.
  const drop = useFileDrop(onFiles, { disabled: importing, accept, onReject })
  return (
    <div
      ref={rootRef}
      className={`${styles.view} ${drop.over ? styles.dropping : ''}`}
      {...drop.handlers}
    >
      {drop.over && <div className={styles.dropVeil}>Drop a CSV or MVR to import fixtures</div>}
      {children}
    </div>
  )
}

export default function PlotView({ plotId, onClose }: { plotId: string; onClose: () => void }) {
  const { doc, snapshot, loaded, undoManager } = usePlot(plotId)
  /**
   * `loaded` alone was the test, and it is not one: `useStoreDoc` always
   * hands back a Y.Doc, so a link to a plot that has been deleted (or one
   * from a different box) minted an empty document, reported it loaded, and
   * rendered a blank plot rather than saying anything. The "Plot not found"
   * branch beneath was unreachable.
   */
  const missing = useDocMissing(doc, loaded)
  /** This view's own subtree, for scoping the undo shortcut to it. */
  const rootRef = useRef<HTMLDivElement>(null)
  const issues = usePlotIssues(snapshot)
  const [tab, setTab] = useState<PlotTab>('fixtures')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = snapshot?.fixtures.find((fixture) => fixture.id === selectedId) ?? null
  const [showPositions, setShowPositions] = useState(false)
  const [showShare, setShowShare] = useState(false)
  // Seeded when the selector imported a file and navigated here — the
  // import summary must survive the route change.
  const [flash, setFlash] = useState<string | null>(() => takeImportFlash())
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
    // shortcut would otherwise swallow a half-typed purpose — and leave
    // everything outside this view alone entirely. See `documentUndoTarget`.
    const undoableTarget = documentUndoTarget(() => rootRef.current)
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

  if (missing) {
    return (
      <div className={styles.loading}>
        Plot not found. It may have been deleted, or this link may be from a different box.
      </div>
    )
  }
  if (!doc || !snapshot || !loaded) {
    return <div className={styles.loading}>Opening plot…</div>
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
      setFlash(await importPlotFile(doc, file))
    } catch (error) {
      setFlash(`Import failed: ${error instanceof Error ? error.message : 'unreadable file'}`)
    } finally {
      setImporting(false)
    }
  }

  return (
    <PlotDropZone
      importing={importing}
      rootRef={rootRef}
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
            onClick={() => {
              void download(plotCsvFilename(snapshot), plotToCsv(snapshot)).then((result) =>
                setFlash(deliveredNote(result, 'Plot'))
              )
            }}
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
          onNotice={setFlash}
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

      {/* Whatever is selected, in whichever view — the drawing says which
          lamp, the list says what it is patched to, and this says what the
          desk is sending it. Nothing to show without a GDTF profile. */}
      {selected && <FixtureChannels fixture={selected} customTypes={snapshot.customTypes} />}

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
