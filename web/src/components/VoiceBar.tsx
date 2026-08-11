import type { PointerEvent } from 'react'
import { channelLabel, useStore } from '../store.ts'

/** Halo ring 8→30px with voice level; must mirror .ptt-btn.talking's resting shadow. */
function talkingHalo(micLevel: number | null): string {
  const level = Math.min(1, (micLevel ?? 0) * 1.6)
  const ring = (8 + level * 22).toFixed(1)
  return `0 0 0 ${ring}px rgba(245, 183, 62, 0.25), 0 8px 24px rgba(0, 0, 0, 0.4)`
}

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
  const resumeVoiceAudio = useStore((s) => s.resumeVoiceAudio)

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
            <path
              fill="currentColor"
              d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.48.48 0 0 0-.59.22L2.74 8.87a.49.49 0 0 0 .12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.01-1.58zM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z"
            />
          </svg>
        </button>
        <button className="voice-leave" onClick={() => void leaveVoice()}>
          Leave
        </button>
      </div>

      {voice.status === 'connected' && (
        <div className="ptt-dock">
          {/* Status pills float above the button; kept out of flow so they
              never shift the talk target under the user's finger. */}
          <div className="ptt-alerts" aria-live="polite">
            {/* First, because it is the only one that means you are hearing
                nothing at all — and the only one a tap fixes. */}
            {voice.audioBlocked && (
              <button className="ptt-blocked" onClick={resumeVoiceAudio}>
                Tap to hear comms
              </button>
            )}
            {(voice.myQuality === 'poor' || voice.myQuality === 'lost') && (
              <span className="ptt-weak" role="status">
                Weak signal — your voice may be choppy
              </span>
            )}
            {speaking.length > 0 && (
              <span className="ptt-speaking">🔊 {speaking.map((p) => p.name).join(', ')}</span>
            )}
          </div>
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
            // Live mic level drives the halo ring — visible proof you're heard.
            // Boosted like the settings meter so normal speech reads clearly.
            // Inline (not a CSS var): Chromium won't retarget a shadow
            // transition when only a var() inside it changes.
            style={voice.talking ? { boxShadow: talkingHalo(voice.micLevel) } : undefined}
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
        </div>
      )}
    </>
  )
}
