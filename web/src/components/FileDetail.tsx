import { useState } from 'react'
import { fileUrl } from '@inter/shared'
import { useStore } from '../store.ts'
import { describeFile, fileCategory, formatBytes } from '../lib/files.ts'

/** In-app detail view for a shared file: preview, facts and actions. */
export default function FileDetail() {
  const message = useStore((s) => s.fileDetail)
  const closeFileDetail = useStore((s) => s.closeFileDetail)
  const users = useStore((s) => s.users)
  const me = useStore((s) => s.me)
  const [copied, setCopied] = useState(false)

  const file = message?.file
  if (!message || !file) return null

  const url = fileUrl(file)
  const absoluteUrl = location.origin + url
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
            <img src={url} alt={file.name} className="file-preview-media" />
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
        </div>
      </div>
    </div>
  )
}
