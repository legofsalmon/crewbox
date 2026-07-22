import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { useStore } from '../store.ts'

const coarsePointer =
  typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches

interface MentionState {
  query: string
  start: number
}

export default function Composer({
  channelId,
  placeholder,
}: {
  channelId: string
  placeholder: string
}) {
  const sendMessage = useStore((s) => s.sendMessage)
  const sendFile = useStore((s) => s.sendFile)
  const sendTyping = useStore((s) => s.sendTyping)
  const uploading = useStore((s) => s.uploading)
  const users = useStore((s) => s.users)
  const me = useStore((s) => s.me)
  const [value, setValue] = useState('')
  const [mention, setMention] = useState<MentionState | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setValue('')
    setMention(null)
    ref.current?.focus()
  }, [channelId])

  const mentionMatches = useMemo(() => {
    if (!mention) return []
    const q = mention.query.toLowerCase()
    const names = [
      ...Object.values(users)
        .filter((u) => u.id !== me?.id)
        .map((u) => u.name),
      'all',
    ]
    return names.filter((n) => n.toLowerCase().startsWith(q)).slice(0, 6)
  }, [mention, users, me])

  function autogrow() {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }

  function detectMention(text: string, caret: number) {
    const upToCaret = text.slice(0, caret)
    const at = upToCaret.lastIndexOf('@')
    if (at === -1 || (at > 0 && !/\s/.test(upToCaret[at - 1]!))) {
      setMention(null)
      return
    }
    const query = upToCaret.slice(at + 1)
    if (query.length > 24 || query.includes('\n')) {
      setMention(null)
      return
    }
    setMention({ query, start: at })
  }

  function insertMention(name: string) {
    if (!mention) return
    const el = ref.current
    const caret = el?.selectionStart ?? value.length
    const next = `${value.slice(0, mention.start)}@${name} ${value.slice(caret)}`
    setValue(next)
    setMention(null)
    requestAnimationFrame(() => {
      el?.focus()
      const pos = mention.start + name.length + 2
      el?.setSelectionRange(pos, pos)
      autogrow()
    })
  }

  function submit() {
    if (!value.trim()) return
    sendMessage(channelId, value)
    setValue('')
    setMention(null)
    requestAnimationFrame(autogrow)
    ref.current?.focus()
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (mention && mentionMatches.length > 0 && (e.key === 'Tab' || e.key === 'Enter')) {
      e.preventDefault()
      insertMention(mentionMatches[0]!)
      return
    }
    if (e.key === 'Escape') setMention(null)
    // On touch devices Enter makes a new line; the send button sends.
    if (e.key === 'Enter' && !e.shiftKey && !coarsePointer) {
      e.preventDefault()
      submit()
    }
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const file = Array.from(e.clipboardData.files)[0]
    if (file) {
      e.preventDefault()
      void sendFile(channelId, file)
    }
  }

  return (
    <div className="composer-wrap">
      {mention && mentionMatches.length > 0 && (
        <div className="mention-pop" role="listbox">
          {mentionMatches.map((name) => (
            <button key={name} role="option" aria-selected={false} onClick={() => insertMention(name)}>
              @{name}
            </button>
          ))}
          <span className="mention-hint">Tab to complete</span>
        </div>
      )}
      <div className="composer">
        <input
          ref={fileRef}
          type="file"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void sendFile(channelId, file)
            e.target.value = ''
          }}
        />
        <button
          className="attach-btn"
          aria-label="Attach a file or photo"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
        >
          {uploading ? (
            <span className="spinner" aria-hidden />
          ) : (
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
              <path
                d="M8 12.5 15.5 5a3.5 3.5 0 0 1 5 5l-9 9a5.5 5.5 0 0 1-7.8-7.8L11 4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          )}
        </button>
        <textarea
          ref={ref}
          rows={1}
          value={value}
          placeholder={placeholder}
          onChange={(e) => {
            setValue(e.target.value)
            autogrow()
            detectMention(e.target.value, e.target.selectionStart ?? e.target.value.length)
            if (e.target.value.trim()) sendTyping(channelId)
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          enterKeyHint="enter"
          maxLength={4000}
        />
        <button
          className="send-btn"
          onClick={submit}
          disabled={!value.trim()}
          aria-label="Send message"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
            <path d="M3 11.5 21 3l-8.5 18-2.3-7.2L3 11.5z" fill="currentColor" />
          </svg>
        </button>
      </div>
    </div>
  )
}
