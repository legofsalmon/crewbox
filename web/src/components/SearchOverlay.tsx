import { useEffect, useRef, useState } from 'react'
import type { Message } from '@inter/shared'
import { channelLabel, useStore } from '../store.ts'
import * as api from '../lib/api.ts'

export default function SearchOverlay() {
  const setSearchOpen = useStore((s) => s.setSearchOpen)
  const setActiveChannel = useStore((s) => s.setActiveChannel)
  const channels = useStore((s) => s.channels)
  const users = useStore((s) => s.users)
  const me = useStore((s) => s.me)

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Message[]>([])
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<number | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (debounceRef.current !== null) clearTimeout(debounceRef.current)
    if (!query.trim()) {
      setResults([])
      return
    }
    debounceRef.current = window.setTimeout(async () => {
      setBusy(true)
      try {
        const token = localStorage.getItem('inter:token') ?? ''
        const { messages } = await api.search(token, query)
        setResults(messages)
      } catch {
        setResults([])
      } finally {
        setBusy(false)
      }
    }, 250)
  }, [query])

  function open(message: Message) {
    setActiveChannel(message.channelId)
    setSearchOpen(false)
  }

  return (
    <div
      className="search-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) setSearchOpen(false)
      }}
      onKeyDown={(e) => e.key === 'Escape' && setSearchOpen(false)}
    >
      <div className="search-panel" role="dialog" aria-label="Search messages">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search messages…"
          aria-label="Search messages"
        />
        <div className="search-results">
          {busy && <div className="search-note">Searching…</div>}
          {!busy && query.trim() && results.length === 0 && (
            <div className="search-note">No matches for “{query}”</div>
          )}
          {results.map((m) => {
            const channel = channels[m.channelId]
            const where = channel
              ? channel.kind === 'dm'
                ? channelLabel(channel, users, me?.id)
                : `#${channel.name}`
              : ''
            const author = m.authorId ? (users[m.authorId]?.name ?? 'Unknown') : 'System'
            return (
              <button key={m.id} className="search-hit" onClick={() => open(m)}>
                <span className="search-hit-meta">
                  <strong>{author}</strong> in {where} ·{' '}
                  {new Date(m.createdAt).toLocaleDateString(undefined, {
                    day: 'numeric',
                    month: 'short',
                  })}
                </span>
                <span className="search-hit-body">{m.body || m.file?.name}</span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
