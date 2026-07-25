import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { fileUrl } from '@inter/shared'
import { useStore } from '../store.ts'
import * as api from '../lib/api.ts'
import { describeFile, fileCategory, formatBytes } from '../lib/files.ts'
import { absoluteFileUrl, apiUrl } from '../lib/server.ts'
import { panBy, zoomAt, zoomIdentity, ZOOM_TAP, type ZoomState } from '../lib/zoom.ts'

const DOUBLE_TAP_MS = 300

/** In-app detail view for a shared file: preview, facts and actions. */
export default function FileDetail() {
  const message = useStore((s) => s.fileDetail)
  const closeFileDetail = useStore((s) => s.closeFileDetail)
  const users = useStore((s) => s.users)
  const me = useStore((s) => s.me)
  const [copied, setCopied] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const file = message?.file
  if (!message || !file) return null

  const url = apiUrl(fileUrl(file))
  const absoluteUrl = absoluteFileUrl(file)
  const category = fileCategory(file.mime)
  const author = message.authorId ? users[message.authorId] : undefined
  const authorName = message.authorId === me?.id ? 'you' : (author?.name ?? 'Unknown')
  const when = new Date(message.createdAt).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
  const canShare = typeof navigator.share === 'function'
  const canDelete = me !== null && (message.authorId === me.id || me.role === 'admin')

  async function copyLink() {
    const flag = () => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
    try {
      await navigator.clipboard.writeText(absoluteUrl)
      flag()
    } catch {
      // No async clipboard (older browsers / denied) — textarea fallback.
      const ta = document.createElement('textarea')
      ta.value = absoluteUrl
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      if (document.execCommand('copy')) flag()
      ta.remove()
    }
  }

  function share() {
    // Cancelled share sheets reject — that's fine, not an error.
    void navigator.share({ title: file!.name, url: absoluteUrl }).catch(() => {})
  }

  async function deleteFile() {
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    setDeleting(true)
    setError(null)
    try {
      await api.deleteMessage(localStorage.getItem('inter:token') ?? '', message!.id)
      // The 'deleted' broadcast also closes us, but don't wait on it.
      closeFileDetail()
    } catch (err) {
      setError(err instanceof api.ApiError ? err.message : 'Delete failed')
      setConfirmDelete(false)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div
      className="search-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeFileDetail()
      }}
      onKeyDown={(e) => e.key === 'Escape' && closeFileDetail()}
    >
      <div className="file-panel" role="dialog" aria-label={`File ${file.name}`}>
        <header className="file-head">
          <h3 className="file-name" title={file.name}>
            {file.name}
          </h3>
          <button className="icon-btn" aria-label="Close file details" onClick={closeFileDetail}>
            ✕
          </button>
        </header>

        <div className="file-preview">
          {category === 'image' ? (
            <ZoomableImage url={url} name={file.name} />
          ) : category === 'video' ? (
            <video src={url} controls playsInline className="file-preview-media" />
          ) : category === 'audio' ? (
            <audio src={url} controls className="file-preview-audio" />
          ) : (
            <div className="file-preview-icon" aria-hidden>
              <svg viewBox="0 0 24 24" width="52" height="52">
                <path
                  d="M6 2h8l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm8 0v5h5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
          )}
        </div>

        <p className="file-meta-line">
          {describeFile(file.mime)} · {formatBytes(file.size)}
        </p>
        <p className="file-meta-line file-meta-muted">
          Shared by {authorName} · {when}
        </p>
        {error && <p className="file-meta-line file-error">{error}</p>}

        <div className="file-actions">
          <a className="file-act" href={url} target="_blank" rel="noreferrer">
            Open
          </a>
          <a className="file-act" href={url} download={file.name}>
            Download
          </a>
          <button className="file-act" onClick={() => void copyLink()}>
            {copied ? 'Copied ✓' : 'Copy link'}
          </button>
          {canShare && (
            <button className="file-act" onClick={share}>
              Share
            </button>
          )}
          {canDelete && (
            <button
              className={`file-act danger ${confirmDelete ? 'confirm' : ''}`}
              disabled={deleting}
              onClick={() => void deleteFile()}
            >
              {deleting ? 'Deleting…' : confirmDelete ? 'Really delete?' : 'Delete'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Pinch/pan/double-tap zoom surface. All gesture math lives in lib/zoom.ts;
 * this component only translates pointer events into it.
 */
function ZoomableImage({ url, name }: { url: string; name: string }) {
  const [zoom, setZoom] = useState<ZoomState>(zoomIdentity)
  const [interacted, setInteracted] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const lastTap = useRef(0)
  const moved = useRef(false)

  useEffect(() => {
    setZoom(zoomIdentity)
    setInteracted(false)
  }, [url])

  // React registers wheel listeners passively — attach directly so
  // preventDefault stops trackpad pinches from zooming the whole page.
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = box.getBoundingClientRect()
      const factor = Math.exp(-e.deltaY * 0.002)
      setInteracted(true)
      setZoom((z) => zoomAt(z, e.clientX - rect.left, e.clientY - rect.top, factor, rect.width, rect.height))
    }
    box.addEventListener('wheel', onWheel, { passive: false })
    return () => box.removeEventListener('wheel', onWheel)
  }, [])

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    try {
      boxRef.current?.setPointerCapture(e.pointerId)
    } catch {
      // Capture is an optimisation (keeps drags outside the box); optional.
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 1) moved.current = false
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const map = pointers.current
    const prev = map.get(e.pointerId)
    if (!prev) return
    const box = boxRef.current!
    const rect = box.getBoundingClientRect()
    if (Math.abs(e.clientX - prev.x) + Math.abs(e.clientY - prev.y) > 4) moved.current = true

    if (map.size === 2) {
      const [a, b] = [...map.values()]
      const prevMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      const prevDist = Math.hypot(a.x - b.x, a.y - b.y) || 1
      map.set(e.pointerId, { x: e.clientX, y: e.clientY })
      const [a2, b2] = [...map.values()]
      const mid = { x: (a2.x + b2.x) / 2, y: (a2.y + b2.y) / 2 }
      const dist = Math.hypot(a2.x - b2.x, a2.y - b2.y) || 1
      setInteracted(true)
      setZoom((z) =>
        zoomAt(
          panBy(z, mid.x - prevMid.x, mid.y - prevMid.y, rect.width, rect.height),
          mid.x - rect.left,
          mid.y - rect.top,
          dist / prevDist,
          rect.width,
          rect.height,
        ),
      )
      return
    }

    map.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (map.size === 1 && zoom.scale > 1) {
      setZoom((z) => panBy(z, e.clientX - prev.x, e.clientY - prev.y, rect.width, rect.height))
    }
  }

  function onPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size > 0 || moved.current) return
    // Double-tap (works for double-click too): toggle zoom at the tap point.
    const now = performance.now()
    if (now - lastTap.current < DOUBLE_TAP_MS) {
      const rect = boxRef.current!.getBoundingClientRect()
      setInteracted(true)
      setZoom((z) =>
        z.scale > 1
          ? zoomIdentity
          : zoomAt(z, e.clientX - rect.left, e.clientY - rect.top, ZOOM_TAP, rect.width, rect.height),
      )
      lastTap.current = 0
      return
    }
    lastTap.current = now
  }

  function onPointerCancel(e: ReactPointerEvent<HTMLDivElement>) {
    pointers.current.delete(e.pointerId)
  }

  return (
    <div
      ref={boxRef}
      className="file-zoom"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <img
        src={url}
        alt={name}
        draggable={false}
        className="file-preview-media"
        style={{
          transform: `translate(${zoom.tx}px, ${zoom.ty}px) scale(${zoom.scale})`,
          transformOrigin: '0 0',
        }}
      />
      {!interacted && <span className="file-zoom-hint">pinch or double-tap to zoom</span>}
    </div>
  )
}
