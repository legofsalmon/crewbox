import { useEffect, useState } from 'react'
import { channelLabel, useStore } from '../store.ts'
import { classifyLatency, LATENCY_LABELS } from '../lib/quality.ts'
import MessageList from './MessageList.tsx'
import Composer from './Composer.tsx'
import SignalBars from './SignalBars.tsx'

export default function ChannelView({ channelId }: { channelId: string }) {
  const channel = useStore((s) => s.channels[channelId])
  const users = useStore((s) => s.users)
  const me = useStore((s) => s.me)
  const online = useStore((s) => s.online)
  const setSidebarOpen = useStore((s) => s.setSidebarOpen)
  const setSearchOpen = useStore((s) => s.setSearchOpen)
  const voice = useStore((s) => s.voice)
  const voiceEnabled = useStore((s) => s.config.voiceEnabled)
  const joinVoice = useStore((s) => s.joinVoice)
  const leaveVoice = useStore((s) => s.leaveVoice)
  const latencyMs = useStore((s) => s.latencyMs)
  const connection = useStore((s) => s.connection)

  if (!channel) return <div className="empty-state">Channel not found</div>

  const label = channelLabel(channel, users, me?.id)
  const otherId = channel.kind === 'dm' ? channel.memberIds?.find((id) => id !== me?.id) : undefined
  const onlineCount = Object.values(online).filter(Boolean).length

  return (
    <div className="channel-view">
      <header className="channel-head">
        <button
          className="icon-btn hamburger"
          aria-label="Open channels"
          onClick={() => setSidebarOpen(true)}
        >
          {/* Drawn, not the ☰ glyph — the iOS webview font lacks it (tofu box). */}
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
            <path
              d="M4 6h16M4 12h16M4 18h16"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <div className="channel-title">
          <h2>
            {channel.kind === 'dm' ? (
              <>
                <span className={`presence-dot ${otherId && online[otherId] ? 'on' : ''}`} />{' '}
                {label}
              </>
            ) : (
              <>
                <span className="row-hash">#</span> {label}
              </>
            )}
          </h2>
          {channel.kind === 'public' && (
            <span className="channel-topic">{channel.topic || `${onlineCount} online`}</span>
          )}
        </div>
        {connection === 'online' && latencyMs !== null && classifyLatency(latencyMs) !== 'good' && (
          <span
            className="weak-signal"
            title={LATENCY_LABELS[classifyLatency(latencyMs)]}
            aria-label={LATENCY_LABELS[classifyLatency(latencyMs)]}
          >
            <SignalBars quality={classifyLatency(latencyMs)} />
            <span className="weak-signal-ms">{latencyMs} ms</span>
          </span>
        )}
        {voiceEnabled && (
          <button
            className={`icon-btn voice-btn ${voice.channelId === channelId ? 'voice-active' : ''}`}
            aria-label={voice.channelId === channelId ? 'Leave voice' : 'Join voice intercom'}
            title={voice.channelId === channelId ? 'Leave voice' : 'Join voice intercom'}
            onClick={() => {
              if (voice.channelId === channelId) void leaveVoice()
              else void joinVoice(channelId)
            }}
          >
            <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden>
              <path
                d="M4 13a8 8 0 0 1 16 0M4 13v4a2 2 0 0 0 2 2h1v-6H6a2 2 0 0 0-2 2zm16 0v4a2 2 0 0 1-2 2h-1v-6h1a2 2 0 0 1 2 2z"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
        <button
          className="icon-btn search-btn"
          aria-label="Search messages"
          title="Search (⌘K)"
          onClick={() => setSearchOpen(true)}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
            <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="m15.5 15.5 5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </header>
      <MessageList channelId={channelId} />
      <TypingLine channelId={channelId} />
      <Composer
        channelId={channelId}
        placeholder={`Message ${channel.kind === 'dm' ? label : `#${label}`}`}
      />
    </div>
  )
}

function TypingLine({ channelId }: { channelId: string }) {
  const typing = useStore((s) => s.typing[channelId])
  const users = useStore((s) => s.users)
  const [, tick] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [])

  const now = Date.now()
  const names = Object.entries(typing ?? {})
    .filter(([, until]) => until > now)
    .map(([userId]) => users[userId]?.name)
    .filter((name): name is string => Boolean(name))

  return (
    <div className="typing-line" aria-live="polite">
      {names.length > 0 &&
        (names.length === 1 ? `${names[0]} is typing…` : `${names.join(', ')} are typing…`)}
    </div>
  )
}
