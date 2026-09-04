import { useEffect, useMemo, useRef, useState } from 'react'
import type * as Y from 'yjs'
import DrawerButton from '../../../shell/DrawerButton.tsx'
import { registerShortcut } from '../../../shell/keys.ts'
import { useStore } from '../../../store.ts'
import { useToasts } from './toastContext.ts'
import { useDocMissing, useSheet } from '../store/hooks'
import { useSheetPeers, useSheetRemotePeers, useSyncStatus } from '../store/useSync'
import { useUndoRedo } from '../store/useUndo'
import { useDraft } from '../../_shared/ui/useDraft'
import { useTimetable } from '../../../shell/timetable/store.ts'
import { setMetaField } from '../model/sheetDoc'
import { sheetActs } from '../model/lineup'
import { findMatches } from '../model/find'
import type { SheetSnapshot } from '../model/types'
import Toolbar from './Toolbar'
import PatchGrid from './PatchGrid'
import SubBoxManager from './SubBoxManager'
import StagePatch from './StagePatch'
import LineupManager from './LineupManager'
import VersionManager from './VersionManager'
import styles from './SheetView.module.scss'

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
  /**
   * A link to a sheet that is not there.
   *
   * `useSheet` always hands back a Y.Doc, so a deleted sheet, or a link
   * pasted from a different box, minted an empty one and sat on "Loading
   * sheet…" for the rest of the session — with the sheet's own id in the
   * URL, which reads as the box having lost it.
   */
  const missing = useDocMissing(doc, loaded)
  const { canUndo, canRedo, undo, redo } = useUndoRedo(undoManager)
  // The acts are the event's, not the sheet's: this stage's slots out of the
  // running order, merged with the spec and notes the sheet keeps about them.
  const { snapshot: timetable, loaded: timetableLoaded } = useTimetable()
  const [showSubBoxes, setShowSubBoxes] = useState(false)
  const [showStagePatch, setShowStagePatch] = useState(false)
  const [showLineup, setShowLineup] = useState(false)
  const [showVersions, setShowVersions] = useState(false)
  const [showShare, setShowShare] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const matchCursor = useRef(0)

  const acts = useMemo(
    () => (snapshot ? sheetActs(snapshot, timetable.acts) : []),
    [snapshot, timetable.acts]
  )

  const matches = useMemo(
    () => (snapshot ? findMatches(snapshot, acts, searchQuery) : null),
    [snapshot, acts, searchQuery]
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
  // Cmd/Ctrl+F focuses the find box.
  // Registered through the shell registry, active only while this view is
  // mounted (i.e. on patch routes) — chat keeps its own shortcuts elsewhere.
  useEffect(() => {
    /**
     * Whether Ctrl+Z here means the *sheet*, rather than what is being typed.
     *
     * It used to mean the sheet everywhere except a grid cell with a
     * half-typed draft, or the find box. So Ctrl+Z in a dialog — the new
     * sheet name, an act's name, the spec and notes boxes in the Lineup —
     * reverted the last committed edit to the sheet behind the modal, while
     * the person pressing it was trying to take back a word they had just
     * typed. Silently: the modal covers the grid.
     *
     * Inverted. Any text-entry element keeps its own text undo, and the sheet
     * only claims the shortcut in a grid cell with nothing in progress —
     * which is the case it was written for, and the one where the browser has
     * nothing of its own to undo.
     */
    const undoableTarget = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true
      if (!typing) return true
      const el = target as HTMLElement
      return Boolean(el.dataset.cell) && !el.dataset.dirty
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

  // The timetable is waited for as well as the sheet, because the columns
  // come from it: rendering a beat early would draw the grid with no acts,
  // flash "nothing is on this sheet", and then mount every cell a second
  // time under whatever finger was already typing into the first one.
  if (missing) {
    return (
      <div className={styles.loading}>
        Sheet not found. It may have been deleted, or this link may be from a different box.
      </div>
    )
  }
  if (!doc || !snapshot || !loaded || !timetableLoaded) {
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
        acts={acts}
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
          acts={acts}
          onOpenLineup={() => setShowLineup(true)}
          matchedCells={matches?.cells}
          matchedChannels={matches?.channels}
          matchedInputs={matches?.inputs}
        />
      </div>

      {showSubBoxes && (
        <SubBoxManager doc={doc} snapshot={snapshot} onClose={() => setShowSubBoxes(false)} />
      )}
      {showStagePatch && (
        <StagePatch snapshot={snapshot} acts={acts} onClose={() => setShowStagePatch(false)} />
      )}
      {showLineup && (
        <LineupManager
          doc={doc}
          snapshot={snapshot}
          acts={acts}
          onClose={() => setShowLineup(false)}
        />
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
