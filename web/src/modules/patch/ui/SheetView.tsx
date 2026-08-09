import { useEffect, useMemo, useRef, useState } from 'react'
import type * as Y from 'yjs'
import DrawerButton from '../../../shell/DrawerButton.tsx'
import { registerShortcut } from '../../../shell/keys.ts'
import { useStore } from '../../../store.ts'
import { useToasts } from './toastContext.ts'
import { useSheet } from '../store/hooks'
import { useSheetPeers, useSheetRemotePeers, useSyncStatus } from '../store/useSync'
import { useUndoRedo } from '../store/useUndo'
import { useDraft } from '../../_shared/ui/useDraft'
import { patchSubBoxDisplay, setMetaField } from '../model/sheetDoc'
import { PATCH_FIELDS, patchKey, type SheetSnapshot } from '../model/types'
import Toolbar from './Toolbar'
import PatchGrid from './PatchGrid'
import SubBoxManager from './SubBoxManager'
import StagePatch from './StagePatch'
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

/**
 * The sheet title, inline in the nav row.
 *
 * Its own component only because `useDraft` is a hook and SheetView returns
 * early while the doc loads — the same reason the lighting plot has one.
 */
function SheetTitle({ doc, snapshot }: { doc: Y.Doc; snapshot: SheetSnapshot }) {
  const title = useDraft(snapshot.meta.title, (next) =>
    setMetaField(doc, 'title', next.trim() || 'Untitled Sheet')
  )
  return (
    <input
      className={styles.title}
      aria-label="Sheet title"
      placeholder="Untitled Sheet"
      maxLength={100}
      {...title.inputProps}
    />
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
  const [showSubBoxes, setShowSubBoxes] = useState(false)
  const [showStagePatch, setShowStagePatch] = useState(false)
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
  // Cmd/Ctrl+F focuses the find box.
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
        handler: () => searchRef.current?.select(),
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
      {/*
        Nav row, then tool row — the same two-row shape as a lighting plot,
        and for the same reason. This used to spend the whole second row on
        the title alone, which cost a phone about 15% of its screen before
        any patch data appeared. The title now sits inline here, and the row
        below holds everything you can *do* to the sheet.

        There used to be a chevron here that collapsed both rows. It was a
        workaround for those rows being tall, and once they weren't it was
        just a control that hid the sheet's own name.
      */}
      <header className={styles.appHeader}>
        <DrawerButton />
        <button
          type="button"
          className={styles.back}
          onClick={onClose}
          aria-label="All sheets"
          title="All sheets"
        >
          ‹
        </button>
        <SheetTitle doc={doc} snapshot={snapshot} />
        <SyncStatusChip sheetId={sheetId} />
        <PresenceAvatars sheetId={sheetId} />
      </header>

      <Toolbar
        doc={doc}
        snapshot={snapshot}
        onOpenSubBoxes={() => setShowSubBoxes(true)}
        onOpenStagePatch={() => setShowStagePatch(true)}
        onOpenLineup={() => setShowLineup(true)}
        onOpenVersions={() => setShowVersions(true)}
        onShare={() => setShowShare(true)}
        history={{ canUndo, canRedo, undo, redo }}
        search={{
          ref: searchRef,
          query: searchQuery,
          matchCount: matches?.order.length ?? 0,
          onChange: (next) => {
            setSearchQuery(next)
            matchCursor.current = 0
          },
          onEnter: jumpToNextMatch,
        }}
      />

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
      {showStagePatch && (
        <StagePatch snapshot={snapshot} onClose={() => setShowStagePatch(false)} />
      )}
      {showLineup && (
        <LineupManager doc={doc} snapshot={snapshot} onClose={() => setShowLineup(false)} />
      )}
      {showVersions && (
        <VersionManager doc={doc} onUndo={undo} onClose={() => setShowVersions(false)} />
      )}
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
