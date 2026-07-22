import type { PointerEvent } from 'react'
import { channelLabel, useStore } from '../store.ts'

/** Sticky intercom strip + the big push-to-talk button. */
export default function VoiceBar() {
  const voice = useStore((s) => s.voice)
  const channels = useStore((s) => s.channels)
  const users = useStore((s) => s.users)
  const me = useStore((s) => s.me)
  const leaveVoice = useStore((s) => s.leaveVoice)
  const setTalking = useStore((s) => s.setTalking)
  const toggleLatch = useStore((s) => s.toggleLatch)
  const setAudioSettingsOpen = useStore((s) => s.setAudioSettingsOpen)

  if (voice.channelId === null || voice.status === 'idle') return null

  const channel = channels[voice.channelId]
  const label = channel ? channelLabel(channel, users, me?.id) : 'voice'
  const speaking = voice.participants.filter((p) => p.speaking)

  function pttDown(e: PointerEvent<HTMLButtonElement>) {
    e.currentTarget.setPointerCapture(e.pointerId)
    setTalking(true)
  }

  function pttUp() {
    setTalking(false)
  }

  return (
    <>
      <div className={`voice-bar ${voice.status === 'reconnecting' ? 'voice-reconnecting' : ''}`}>
        <span className="voice-live-dot" aria-hidden />
        <span className="voice-room">
          {voice.status === 'joining'
            ? 'Joining voice…'
            : voice.status === 'reconnecting'
              ? 'Voice reconnecting…'
              : `Voice · ${channel?.kind === 'dm' ? label : `#${label}`}`}
        </span>
        <span className="voice-people">
          {voice.participants.map((p) => (
            <span key={p.id} className={`voice-chip ${p.speaking ? 'speaking' : ''}`}>
              <span className={`q-dot q-${p.quality}`} aria-hidden />
              {p.name}
            </span>
          ))}
        </span>
        {voice.status === 'connected' && !voice.micReady && (
          <span className="voice-note">listen-only</span>
        )}
        <button
          className="icon-btn"
          aria-label="Audio settings"
          title="Audio settings"
          onClick={() => setAudioSettingsOpen(true)}
        >
          <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden>
            <circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" strokeWidth="2" />
            <path
              d="M12 2.8v3M12 18.2v3M21.2 12h-3M5.8 12h-3M18.5 5.5l-2.1 2.1M7.6 16.4l-2.1 2.1M18.5 18.5l-2.1-2.1M7.6 7.6 5.5 5.5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <button className="voice-leave" onClick={() => void leaveVoice()}>
          Leave
        </button>
      </div>

      {voice.status === 'connected' && (
        <div className="ptt-dock">
          <button
            className={`latch-btn ${voice.latched ? 'on' : ''}`}
            aria-label={voice.latched ? 'Unlock mic (stop talking)' : 'Lock mic open'}
            title={voice.latched ? 'Mic locked open — tap to release' : 'Lock mic open'}
            onClick={toggleLatch}
          >
            {voice.latched ? '🔓' : '🔒'}
          </button>
          <button
            className={`ptt-btn ${voice.talking ? 'talking' : ''}`}
            aria-label="Hold to talk"
            onPointerDown={pttDown}
            onPointerUp={pttUp}
            onPointerCancel={pttUp}
            onContextMenu={(e) => e.preventDefault()}
          >
            <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden>
              <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
              <path
                d="M5 11a7 7 0 0 0 14 0M12 18v3"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
            <span>{voice.talking ? 'LIVE' : 'HOLD'}</span>
          </button>
          {(voice.myQuality === 'poor' || voice.myQuality === 'lost') && (
            <span className="ptt-weak" role="status">
              Weak signal — your voice may be choppy
            </span>
          )}
          {speaking.length > 0 && (
            <span className="ptt-speaking" aria-live="polite">
              🔊 {speaking.map((p) => p.name).join(', ')}
            </span>
          )}
        </div>
      )}
    </>
  )
}
