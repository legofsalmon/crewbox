import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import { fileUrl, type FileMeta, type Message } from '@inter/shared'
import { useStore, type Pending } from '../store.ts'
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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
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

function FileAttachment({ file }: { file: FileMeta }) {
  const url = fileUrl(file)
  if (file.mime.startsWith('image/')) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="msg-image-link">
        <img src={url} alt={file.name} loading="lazy" className="msg-image" />
      </a>
    )
  }
  return (
    <a href={url} download={file.name} className="file-card">
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
        <span className="file-card-size">{formatSize(file.size)}</span>
      </span>
    </a>
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

  const scrollRef = useRef<HTMLDivElement>(null)
  const nearBottomRef = useRef(true)
  const prevHeightRef = useRef<number | null>(null)
  const [newBelow, setNewBelow] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  const list = messages ?? []
  const pendingList = pending ?? []
  const lastSeq = list.at(-1)?.seq ?? 0
  const lastPendingId = pendingList.at(-1)?.clientMsgId

  const userNames = useMemo(() => Object.values(users).map((u) => u.name), [users])

  // Jump straight to the bottom when switching channels.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    nearBottomRef.current = true
    setNewBelow(false)
  }, [channelId])

  // Follow new messages if we're already at the bottom, else show the pill.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
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

  useEffect(() => {
    const onFocus = () => {
      if (nearBottomRef.current) markChannelRead(channelId)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [channelId, markChannelRead])

  function onScroll() {
    const el = scrollRef.current
    if (!el) return
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    nearBottomRef.current = fromBottom < NEAR_BOTTOM_PX
    if (nearBottomRef.current) {
      setNewBelow(false)
      markChannelRead(channelId)
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
        <div className="system-msg" key={msg.id}>
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
        body={msg.body}
        file={msg.file}
        authorName={author?.name ?? 'Unknown'}
        authorId={msg.authorId ?? '?'}
        ts={msg.createdAt}
        grouped={grouped}
        userNames={userNames}
        myName={me?.name}
      />,
    )
    prevMsg = msg
  }
  for (const p of pendingList) {
    rows.push(
      <MessageRow
        key={p.clientMsgId}
        body={p.body}
        file={p.fileId ? { id: p.fileId, name: p.fileName ?? 'file', mime: p.fileMime ?? '', size: 0 } : undefined}
        authorName={me?.name ?? 'Me'}
        authorId={me?.id ?? '?'}
        ts={p.createdAt}
        grouped={false}
        pending
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
      {newBelow && (
        <button className="jump-pill" onClick={jumpToLatest}>
          New messages ↓
        </button>
      )}
    </div>
  )
}

function MessageRow(props: {
  body: string
  file?: FileMeta
  authorName: string
  authorId: string
  ts: number
  grouped: boolean
  pending?: boolean
  userNames: string[]
  myName?: string
}) {
  const { body, file, authorName, authorId, ts, grouped, pending, userNames, myName } = props
  return (
    <div className={`msg ${grouped ? 'grouped' : ''} ${pending ? 'pending' : ''}`}>
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
        {file && (pending ? <div className="msg-body msg-file-pending">📎 {file.name}</div> : <FileAttachment file={file} />)}
        {grouped && pending && <span className="msg-state">◷</span>}
      </div>
    </div>
  )
}
