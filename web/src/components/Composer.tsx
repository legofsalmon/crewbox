import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react'
import { useStore } from '../store.ts'
import { cameraAllowed, isAndroidApp, nativeScanner } from '../lib/server.ts'
import AttachMenu from './AttachMenu.tsx'

const coarsePointer =
  typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches

/**
 * Unsent text, per channel, for the length of the session.
 *
 * Switching channel used to wipe whatever was half-typed — a crew member who
 * flicked to another channel to check something, then came back, found their
 * message gone. Keyed by channel id and held here (module scope, not state)
 * so it survives the switch and any remount, and cleared when the message is
 * actually sent. In memory only: a reload starts clean, which is fine — the
 * loss this fixes is the channel flick, which happens constantly, not the
 * reload, which doesn't.
 */
const drafts = new Map<string, string>()

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
  const cameraRef = useRef<HTMLInputElement>(null)
  const attachRef = useRef<HTMLButtonElement>(null)
  const [attachOpen, setAttachOpen] = useState(false)
  const closeAttach = useCallback(() => setAttachOpen(false), [])
  // The one place the phone's own picker has no camera (see AttachMenu).
  const offersCamera = isAndroidApp()
  const [cameraRefused, setCameraRefused] = useState(false)

  // Track the value in the per-channel draft store so it survives a switch,
  // and clear the entry once nothing is left to keep.
  function commitValue(next: string) {
    setValue(next)
    if (next) drafts.set(channelId, next)
    else drafts.delete(channelId)
  }

  useEffect(() => {
    // Restore this channel's draft rather than blanking the box.
    setValue(drafts.get(channelId) ?? '')
    setMention(null)
    setAttachOpen(false)
    setCameraRefused(false)
    // Not on a phone. Focusing the box opens the soft keyboard, so every tap
    // on a channel in the drawer arrived with half the screen gone and the
    // messages the crew member had just navigated to pushed out of sight —
    // to write a message they had not said they wanted to write. On a
    // keyboard there is no cost and it saves a click, which is why it is
    // here at all.
    if (!coarsePointer) ref.current?.focus()
    requestAnimationFrame(autogrow)
  }, [channelId])

  // Android doesn't open the camera for an app that isn't allowed it, and
  // the web view tells the page no more than that the photo was cancelled,
  // as it does when somebody backs out of the camera. So a cancel asks
  // whether the camera is allowed, and a camera that isn't gets said: once
  // somebody has said no twice, Android stops asking, and Take a photo would
  // otherwise do nothing at all, for good.
  useEffect(() => {
    const camera = cameraRef.current
    if (!camera) return
    const onCancel = () => {
      void cameraAllowed().then((allowed) => {
        if (allowed === false) setCameraRefused(true)
      })
    }
    camera.addEventListener('cancel', onCancel)
    return () => camera.removeEventListener('cancel', onCancel)
  }, [offersCamera])

  // Back from Settings with the camera allowed, the note has nothing to say.
  useEffect(() => {
    if (!cameraRefused) return
    const recheck = () => {
      if (document.visibilityState !== 'visible') return
      void cameraAllowed().then((allowed) => {
        if (allowed) setCameraRefused(false)
      })
    }
    document.addEventListener('visibilitychange', recheck)
    return () => document.removeEventListener('visibilitychange', recheck)
  }, [cameraRefused])

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
    commitValue(next)
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
    commitValue('')
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

  function onPicked(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) void sendFile(channelId, file)
    e.target.value = ''
    setCameraRefused(false)
  }

  function onAttach() {
    if (!offersCamera) {
      fileRef.current?.click()
      return
    }
    setMention(null)
    setCameraRefused(false)
    setAttachOpen((open) => !open)
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
            <button
              key={name}
              role="option"
              aria-selected={false}
              onClick={() => insertMention(name)}
            >
              @{name}
            </button>
          ))}
          <span className="mention-hint">Tab to complete</span>
        </div>
      )}
      {attachOpen && (
        <AttachMenu
          anchor={attachRef}
          onCamera={() => cameraRef.current?.click()}
          onFile={() => fileRef.current?.click()}
          onClose={closeAttach}
        />
      )}
      {cameraRefused && (
        <div className="camera-note" role="status">
          <div className="camera-note-body">
            <span>
              Crewbox isn’t allowed to use the camera. Allow it in Settings, or choose a photo
              already on the phone.
            </span>
            <button
              className="admin-btn"
              onClick={() =>
                void nativeScanner()
                  ?.openSettings()
                  .catch(() => {})
              }
            >
              Open Settings
            </button>
          </div>
          <button
            className="camera-note-close"
            aria-label="Dismiss"
            onClick={() => setCameraRefused(false)}
          >
            ✕
          </button>
        </div>
      )}
      <div className="composer">
        <input ref={fileRef} type="file" hidden onChange={onPicked} />
        {offersCamera && (
          <input
            ref={cameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={onPicked}
          />
        )}
        <button
          ref={attachRef}
          className="attach-btn"
          aria-label="Attach a file or photo"
          aria-haspopup={offersCamera ? 'menu' : undefined}
          aria-expanded={offersCamera ? attachOpen : undefined}
          disabled={uploading}
          onClick={onAttach}
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
            commitValue(e.target.value)
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
