import { useEffect, useMemo, useRef, useState } from 'react'
import { registerShortcut } from '../../../shell/keys.ts'
import { useStore } from '../../../store.ts'
import { useToasts } from './toastContext.ts'
import { useSheet } from '../store/hooks'
import { useSheetPeers, useSheetRemotePeers, useSyncStatus } from '../store/useSync'
import { useUndoRedo } from '../store/useUndo'
import { patchSubBoxDisplay } from '../model/sheetDoc'
import { PATCH_FIELDS, patchKey, type SheetSnapshot } from '../model/types'
import Toolbar from './Toolbar'
import PatchGrid from './PatchGrid'
import SubBoxManager from './SubBoxManager'
import LineupManager from './LineupManager'
import VersionManager from './VersionManager'
import styles from './SheetView.module.scss'

/** All cells (and channel labels) whose display value contains the query. */
const findMatches = (snapshot: SheetSnapshot, query: string) => {
  const cells = new Set<string>()
  const channels = new Set<string>()
  const q = query.trim().toLowerCase()
  if (!q) return { cells, channels, order: [] as string[] }
  const order: string[] = []
  for (const channel of snapshot.channels) {
    if (channel.label.toLowerCase().includes(q)) channels.add(channel.id)
    for (const artist of snapshot.artists) {
      const entry = snapshot.patches[patchKey(artist.id, channel.id)]
      if (!entry) continue
      for (const field of PATCH_FIELDS) {
        const display =
          field === 'subBox' ? patchSubBoxDisplay(entry, snapshot.subBoxes) : entry[field]
        if (display && display.toLowerCase().includes(q)) {
          const cellId = `${artist.id}:${channel.id}:${field}`
          cells.add(cellId)
          order.push(cellId)
        }
      }
    }
  }
  return { cells, channels, order }
}

function PresenceAvatars({ sheetId }: { sheetId: string }) {
  const peers = useSheetRemotePeers(sheetId)
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

function SyncStatusChip({ sheetId }: { sheetId: string }) {
  const status = useSyncStatus()
  const peers = useSheetPeers(sheetId)

  const label =
    status === 'off'
      ? 'Local only'
      : status === 'connecting'
        ? 'Connecting…'
        : peers > 1
          ? `Synced · ${peers} devices`
          : 'Synced'

  return (
    <span className={`${styles.statusChip} ${styles[status]}`}>
      <span className={styles.statusDot} aria-hidden="true" />
      {label}
    </span>
  )
}

function ShareMenu({
  sheetId,
  title,
  onClose,
}: {
  sheetId: string
  title: string
  onClose: () => void
}) {
  const channels = useStore((s) => s.channels)
  const sendMessage = useStore((s) => s.sendMessage)
  const { addToast } = useToasts()
  const publicChannels = Object.values(channels)
    .filter((c) => c.kind === 'public' && !c.retired)
    .sort((a, b) => a.createdAt - b.createdAt)

  return (
    <div className={styles.shareOverlay} onClick={onClose}>
      <div
        className={styles.shareMenu}
        role="dialog"
        aria-label="Share sheet to a channel"
        onClick={(e) => e.stopPropagation()}
      >
        <p className={styles.shareTitle}>Share to channel</p>
        {publicChannels.map((channel) => (
          <button
            key={channel.id}
            type="button"
            className={styles.shareChannel}
            onClick={() => {
              sendMessage(channel.id, `📋 Patch sheet “${title}” — /m/patch/sheet/${sheetId}`)
              addToast('Shared', `Sheet link posted in #${channel.name}`, 'success')
              onClose()
            }}
          >
            #{channel.name}
          </button>
        ))}
      </div>
    </div>
  )
}

export default function SheetView({ sheetId, onClose }: { sheetId: string; onClose: () => void }) {
  const { doc, snapshot, loaded, undoManager } = useSheet(sheetId)
  const { canUndo, canRedo, undo, redo } = useUndoRedo(undoManager)
  const [showHeaders, setShowHeaders] = useState(true)
  const [showSubBoxes, setShowSubBoxes] = useState(false)
  const [showLineup, setShowLineup] = useState(false)
  const [showVersions, setShowVersions] = useState(false)
  const [showShare, setShowShare] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const matchCursor = useRef(0)

  const matches = useMemo(
    () => (snapshot ? findMatches(snapshot, searchQuery) : null),
    [snapshot, searchQuery]
  )

  const jumpToNextMatch = () => {
    if (!matches || matches.order.length === 0) return
    const cellId = matches.order[matchCursor.current % matches.order.length]
    matchCursor.current++
    const input = document.querySelector<HTMLInputElement>(
      `input[data-cell="${CSS.escape(cellId)}"]`
    )
    if (input) {
      input.focus()
      input.select()
      input.scrollIntoView({ block: 'center', inline: 'center' })
    }
  }

  // Cmd/Ctrl+Z undoes the last committed edit; Shift adds redo (Ctrl+Y too).
  // A field with an in-progress draft (data-dirty) keeps native text undo.
  // Cmd/Ctrl+F opens the find box (revealing the header if collapsed).
  // Registered through the shell registry, active only while this view is
  // mounted (i.e. on patch routes) — chat keeps its own shortcuts elsewhere.
  useEffect(() => {
    const undoableTarget = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      return !(
        (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) &&
        (target.dataset.dirty || target.dataset.search)
      )
    }
    const unregister = [
      registerShortcut({
        key: 'f',
        mod: true,
        handler: () => {
          setShowHeaders(true)
          // The input may mount with the header on the next frame.
          requestAnimationFrame(() => searchRef.current?.select())
        },
      }),
      registerShortcut({ key: 'z', mod: true, when: undoableTarget, handler: () => undo() }),
      registerShortcut({
        key: 'z',
        mod: true,
        shift: true,
        when: undoableTarget,
        handler: () => redo(),
      }),
      registerShortcut({ key: 'y', mod: true, when: undoableTarget, handler: () => redo() }),
    ]
    return () => unregister.forEach((fn) => fn())
  }, [undo, redo])

  if (!doc || !snapshot || !loaded) {
    return <div className={styles.loading}>Loading sheet…</div>
  }

  return (
    <div className={styles.app}>
      <button
        type="button"
        className={styles.headerToggle}
        onClick={() => setShowHeaders((v) => !v)}
        aria-expanded={showHeaders}
        title={showHeaders ? 'Hide headers to save space' : 'Show headers'}
      >
        <span className={showHeaders ? styles.chevronUp : styles.chevronDown} aria-hidden="true">
          ▲
        </span>
      </button>

      {showHeaders && (
        <header className={styles.appHeader}>
          <div className={styles.headerLeft}>
            <button type="button" className={styles.loadButton} onClick={onClose}>
              ← Sheets
            </button>
            <span className={styles.undoGroup}>
              <button
                type="button"
                className={styles.undoButton}
                onClick={undo}
                disabled={!canUndo}
                title="Undo (Ctrl/Cmd+Z)"
                aria-label="Undo"
              >
                ↶
              </button>
              <button
                type="button"
                className={styles.undoButton}
                onClick={redo}
                disabled={!canRedo}
                title="Redo (Ctrl/Cmd+Shift+Z)"
                aria-label="Redo"
              >
                ↷
              </button>
            </span>
          </div>
          <div className={styles.searchBox}>
            <input
              ref={searchRef}
              type="text"
              placeholder="Find…  (Ctrl+F)"
              aria-label="Find in sheet"
              data-search="true"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value)
                matchCursor.current = 0
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') jumpToNextMatch()
                else if (e.key === 'Escape') {
                  setSearchQuery('')
                  ;(e.target as HTMLElement).blur()
                }
              }}
            />
            {searchQuery.trim() && (
              <span className={styles.matchCount}>
                {matches?.order.length ?? 0} match{(matches?.order.length ?? 0) === 1 ? '' : 'es'}
              </span>
            )}
          </div>
          <div className={styles.headerRight}>
            <PresenceAvatars sheetId={sheetId} />
            <button
              type="button"
              className={styles.loadButton}
              onClick={() => setShowShare(true)}
              title="Share this sheet into a chat channel"
            >
              Share
            </button>
            <SyncStatusChip sheetId={sheetId} />
          </div>
        </header>
      )}

      {showHeaders && (
        <Toolbar
          doc={doc}
          snapshot={snapshot}
          onOpenSubBoxes={() => setShowSubBoxes(true)}
          onOpenLineup={() => setShowLineup(true)}
          onOpenVersions={() => setShowVersions(true)}
        />
      )}

      <div className={styles.gridArea}>
        <PatchGrid
          doc={doc}
          sheetId={sheetId}
          snapshot={snapshot}
          matchedCells={matches?.cells}
          matchedChannels={matches?.channels}
        />
      </div>

      {showSubBoxes && (
        <SubBoxManager doc={doc} snapshot={snapshot} onClose={() => setShowSubBoxes(false)} />
      )}
      {showLineup && (
        <LineupManager doc={doc} snapshot={snapshot} onClose={() => setShowLineup(false)} />
      )}
      {showVersions && <VersionManager doc={doc} onClose={() => setShowVersions(false)} />}
      {showShare && (
        <ShareMenu
          sheetId={sheetId}
          title={snapshot.meta.title || 'Untitled Sheet'}
          onClose={() => setShowShare(false)}
        />
      )}
    </div>
  )
}
