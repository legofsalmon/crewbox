import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import { fileUrl, thumbUrl, type FileMeta, type Message } from '@inter/shared'
import { useStore, type Pending } from '../store.ts'
import { formatBytes } from '../lib/files.ts'
import { apiUrl } from '../lib/server.ts'
import Avatar from './Avatar.tsx'

const GROUP_GAP_MS = 5 * 60 * 1000
const NEAR_BOTTOM_PX = 90

function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function dayLabel(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const yesterday = new Date(today.getTime() - 86_400_000)
  if (dayKey(ts) === dayKey(today.getTime())) return 'Today'
  if (dayKey(ts) === dayKey(yesterday.getTime())) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}

function time(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}


/** Highlight @mentions of known names (plus @all/@everyone/@channel). */
function renderBody(body: string, names: string[], myName: string | undefined): ReactNode {
  const candidates = [...names, 'all', 'everyone', 'channel'].sort((a, b) => b.length - a.length)
  const nodes: ReactNode[] = []
  let cursor = 0
  let key = 0
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '@') continue
    const rest = body.slice(i + 1).toLowerCase()
    const hit = candidates.find((n) => rest.startsWith(n.toLowerCase()))
    if (!hit) continue
    if (i > cursor) nodes.push(body.slice(cursor, i))
    const text = body.slice(i, i + hit.length + 1)
    const isMe = myName !== undefined && hit.toLowerCase() === myName.toLowerCase()
    const isBroadcast = ['all', 'everyone', 'channel'].includes(hit.toLowerCase())
    nodes.push(
      <mark key={key++} className={`mention ${isMe || isBroadcast ? 'mention-me' : ''}`}>
        {text}
      </mark>,
    )
    cursor = i + hit.length + 1
    i = cursor - 1
  }
  if (nodes.length === 0) return body
  if (cursor < body.length) nodes.push(body.slice(cursor))
  return nodes
}

/** Bubble box for an image with known dimensions, mirroring the CSS caps. */
const IMAGE_MAX_W = 360
const IMAGE_MAX_H = 300

/** Attachments open the in-app detail modal; raw open/download live there. */
function FileAttachment({
  file,
  onOpen,
  onImgLoad,
}: {
  file: FileMeta
  onOpen: () => void
  onImgLoad?: () => void
}) {
  const url = apiUrl(fileUrl(file))
  if (file.mime.startsWith('image/')) {
    // Preview when one exists; reserve the layout box up front when the
    // dimensions are known so loading never shifts the transcript.
    const src = file.hasThumb ? apiUrl(thumbUrl(file)) : url
    let style: { width: string; aspectRatio: string } | undefined
    if (file.width && file.height) {
      const scale = Math.min(IMAGE_MAX_W / file.width, IMAGE_MAX_H / file.height, 1)
      style = {
        width: `${Math.round(file.width * scale)}px`,
        aspectRatio: `${file.width} / ${file.height}`,
      }
    }
    return (
      <button type="button" className="msg-image-link" onClick={onOpen}>
        <img
          src={src}
          alt={file.name}
          loading="lazy"
          decoding="async"
          className="msg-image"
          style={style}
          onLoad={style ? undefined : onImgLoad}
        />
      </button>
    )
  }
  return (
    <button type="button" className="file-card" onClick={onOpen}>
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
        <path
          d="M6 2h8l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm8 0v5h5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
      <span className="file-card-info">
        <span className="file-card-name">{file.name}</span>
        <span className="file-card-size">{formatBytes(file.size)}</span>
      </span>
    </button>
  )
}

export default function MessageList({ channelId }: { channelId: string }) {
  const messages = useStore((s) => s.messages[channelId])
  const pending = useStore((s) => s.pending[channelId])
  const users = useStore((s) => s.users)
  const me = useStore((s) => s.me)
  const loadOlder = useStore((s) => s.loadOlder)
  const markChannelRead = useStore((s) => s.markChannelRead)
  const sendFile = useStore((s) => s.sendFile)
  const jumpTarget = useStore((s) => s.jumpTarget)
  const clearJumpTarget = useStore((s) => s.clearJumpTarget)
  const gapped = useStore((s) => s.historyGapped[channelId] ?? false)
  const returnToLatest = useStore((s) => s.returnToLatest)

  const scrollRef = useRef<HTMLDivElement>(null)
  const nearBottomRef = useRef(true)
  const prevHeightRef = useRef<number | null>(null)
  const [newBelow, setNewBelow] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [flashSeq, setFlashSeq] = useState<number | null>(null)

  const list = messages ?? []
  const pendingList = pending ?? []
  const lastSeq = list.at(-1)?.seq ?? 0
  const lastPendingId = pendingList.at(-1)?.clientMsgId

  const userNames = useMemo(() => Object.values(users).map((u) => u.name), [users])

  // Jump straight to the bottom when switching channels — unless we're
  // arriving on a search jump, which positions itself below.
  useLayoutEffect(() => {
    if (useStore.getState().jumpTarget?.channelId === channelId) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    nearBottomRef.current = true
    setNewBelow(false)
  }, [channelId])

  // Search jump: center the target row and flash it once it exists.
  const justJumpedRef = useRef(false)
  useLayoutEffect(() => {
    if (!jumpTarget || jumpTarget.channelId !== channelId) return
    const row = scrollRef.current?.querySelector(`[data-seq="${jumpTarget.seq}"]`)
    if (!row) return
    row.scrollIntoView({ block: 'center' })
    nearBottomRef.current = false
    justJumpedRef.current = true
    setFlashSeq(jumpTarget.seq)
    clearJumpTarget()
    const timer = setTimeout(() => setFlashSeq(null), 1800)
    return () => clearTimeout(timer)
  }, [jumpTarget, channelId, lastSeq, clearJumpTarget])

  // Follow new messages if we're already at the bottom, else show the pill.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (justJumpedRef.current) {
      // This render was a search jump landing, not new traffic.
      justJumpedRef.current = false
      return
    }
    if (prevHeightRef.current !== null) {
      // We just prepended history — keep the viewport anchored.
      el.scrollTop += el.scrollHeight - prevHeightRef.current
      prevHeightRef.current = null
      return
    }
    if (nearBottomRef.current) {
      el.scrollTop = el.scrollHeight
    } else {
      setNewBelow(true)
    }
  }, [lastSeq, lastPendingId])

  // Leaving a gapped history view (returnToLatest) lands on the newest
  // message. Declared after the follow effect so it wins this commit.
  const prevGappedRef = useRef(gapped)
  useLayoutEffect(() => {
    if (prevGappedRef.current && !gapped) {
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
      nearBottomRef.current = true
      setNewBelow(false)
    }
    prevGappedRef.current = gapped
  }, [gapped])

  useEffect(() => {
    const onFocus = () => {
      // The bottom of a gapped history view is not the real latest message.
      if (nearBottomRef.current && !gapped) markChannelRead(channelId)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [channelId, markChannelRead, gapped])

  function onScroll() {
    const el = scrollRef.current
    if (!el) return
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    nearBottomRef.current = fromBottom < NEAR_BOTTOM_PX
    if (nearBottomRef.current) {
      setNewBelow(false)
      if (!gapped) markChannelRead(channelId)
    }
    if (el.scrollTop < 60 && list.length > 0 && (list[0]?.seq ?? 1) > 1) {
      prevHeightRef.current = el.scrollHeight
      void loadOlder(channelId).then(() => {
        // If nothing was prepended, drop the anchor so new tail messages scroll.
        if (scrollRef.current && prevHeightRef.current === scrollRef.current.scrollHeight) {
          prevHeightRef.current = null
        }
      })
    }
  }

  function jumpToLatest() {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    nearBottomRef.current = true
    setNewBelow(false)
    markChannelRead(channelId)
  }

  // Legacy images (uploaded before dimensions were captured) still shift the
  // layout when they load — stay glued to the bottom if we were there.
  // Stable identity so memoized rows never re-render because of it.
  const onImgLoad = useCallback(() => {
    const el = scrollRef.current
    if (el && nearBottomRef.current) el.scrollTop = el.scrollHeight
  }, [])

  const rows: JSX.Element[] = []
  let prevMsg: Message | null = null
  for (const msg of list) {
    if (!prevMsg || dayKey(prevMsg.createdAt) !== dayKey(msg.createdAt)) {
      rows.push(
        <div className="day-divider" key={`day-${msg.id}`}>
          <span>{dayLabel(msg.createdAt)}</span>
        </div>,
      )
      prevMsg = null
    }
    if (msg.kind === 'system') {
      rows.push(
        <div className="system-msg" key={msg.id} data-seq={msg.seq}>
          {msg.body}
        </div>,
      )
      prevMsg = msg
      continue
    }
    const grouped =
      prevMsg !== null &&
      prevMsg.kind !== 'system' &&
      prevMsg.authorId === msg.authorId &&
      msg.createdAt - prevMsg.createdAt < GROUP_GAP_MS
    const author = msg.authorId ? users[msg.authorId] : undefined
    rows.push(
      <MessageRow
        key={msg.id}
        msg={msg}
        authorName={author?.name ?? 'Unknown'}
        authorId={msg.authorId ?? '?'}
        grouped={grouped}
        userNames={userNames}
        myName={me?.name}
        onImgLoad={onImgLoad}
        flashed={msg.seq === flashSeq}
      />,
    )
    prevMsg = msg
  }
  for (const p of pendingList) {
    rows.push(
      <MessageRow
        key={p.clientMsgId}
        pendingEntry={p}
        authorName={me?.name ?? 'Me'}
        authorId={me?.id ?? '?'}
        grouped={false}
        userNames={userNames}
        myName={me?.name}
      />,
    )
  }

  return (
    <div
      className={`message-scroll ${dragOver ? 'drag-over' : ''}`}
      ref={scrollRef}
      onScroll={onScroll}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        const file = e.dataTransfer.files[0]
        if (file) void sendFile(channelId, file)
      }}
    >
      <div className="message-inner">
        {list.length === 0 && pendingList.length === 0 && (
          <div className="empty-state">No messages yet — say hello 👋</div>
        )}
        {rows}
      </div>
      {dragOver && <div className="drop-hint">Drop to share</div>}
      {gapped ? (
        <button className="jump-pill" onClick={() => void returnToLatest(channelId)}>
          Jump to latest ↓
        </button>
      ) : (
        newBelow && (
          <button className="jump-pill" onClick={jumpToLatest}>
            New messages ↓
          </button>
        )
      )}
    </div>
  )
}

/**
 * Memoized: appends to the list no longer re-render every existing row
 * (and re-run the mention scanner across the whole transcript). All props
 * are identity-stable across appends; `openFileDetail` comes from the
 * store, whose action references never change.
 */
const MessageRow = memo(function MessageRow(props: {
  /** Delivered message; exactly one of msg/pendingEntry is set. */
  msg?: Message
  pendingEntry?: Pending
  authorName: string
  authorId: string
  grouped: boolean
  userNames: string[]
  myName?: string
  onImgLoad?: () => void
  /** Briefly highlighted as a search-jump landing. */
  flashed?: boolean
}) {
  const { msg, pendingEntry, authorName, authorId, grouped, userNames, myName, onImgLoad, flashed } = props
  const openFileDetail = useStore((s) => s.openFileDetail)

  const pending = !msg
  const body = msg?.body ?? pendingEntry?.body ?? ''
  const ts = msg?.createdAt ?? pendingEntry?.createdAt ?? 0
  const file: FileMeta | undefined =
    msg?.file ??
    (pendingEntry?.fileId
      ? { id: pendingEntry.fileId, name: pendingEntry.fileName ?? 'file', mime: pendingEntry.fileMime ?? '', size: 0 }
      : undefined)

  return (
    <div
      className={`msg ${grouped ? 'grouped' : ''} ${pending ? 'pending' : ''} ${flashed ? 'msg-flash' : ''}`}
      data-seq={msg?.seq}
    >
      <div className="msg-gutter">{!grouped && <Avatar name={authorName} id={authorId} />}</div>
      <div className="msg-content">
        {!grouped && (
          <div className="msg-head">
            <span className="msg-author">{authorName}</span>
            <span className="msg-time">{time(ts)}</span>
            {pending && <span className="msg-state">sending…</span>}
          </div>
        )}
        {body && <div className="msg-body">{renderBody(body, userNames, myName)}</div>}
        {file &&
          (msg ? (
            <FileAttachment file={file} onOpen={() => openFileDetail(msg)} onImgLoad={onImgLoad} />
          ) : (
            <div className="msg-body msg-file-pending">📎 {file.name}</div>
          ))}
        {grouped && pending && <span className="msg-state">◷</span>}
      </div>
    </div>
  )
})
