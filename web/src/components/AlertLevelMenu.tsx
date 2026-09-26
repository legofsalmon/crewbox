import { useEffect, useRef, useState } from 'react'
import { levelFor, type ChannelAlertLevel } from '@crewbox/shared'
import { useStore } from '../store.ts'
import { BellIcon } from './alertIcons.tsx'
import { CHANNEL_LEVELS, DM_LEVELS, LEVEL_TEXT, dmText } from '../lib/alertLevels.ts'

/**
 * The bell in a channel's header: how much of this channel reaches this
 * person's pocket (docs/ALERTS.md).
 *
 * Kept on the box, so the phone in their pocket and the laptop at FOH agree,
 * and the iPhone's alerts, which can't read this page's storage, follow it.
 * Shown only by a box that decides alerts; an older one has nowhere to keep it.
 */
export default function AlertLevelMenu({
  channelId,
  name,
  dm = false,
}: {
  channelId: string
  name: string
  dm?: boolean
}) {
  const boxDecides = useStore((s) => Boolean(s.config.alerts))
  const stored = useStore((s) => levelFor(s.alertSettings, channelId))
  const level = dm && stored === 'all' ? 'mentions' : stored
  const text = (option: ChannelAlertLevel) => (dm ? dmText(option) : LEVEL_TEXT[option])
  const setChannelAlerts = useStore((s) => s.setChannelAlerts)
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setOpen(false)
  }, [channelId])

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])

  if (!boxDecides) return null

  return (
    <div className="alert-level" ref={menuRef}>
      <button
        className={`icon-btn alert-level-btn alert-level-${level}`}
        aria-label={`Alerts for ${name}: ${text(level).label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Alerts: ${text(level).label}`}
        onClick={() => setOpen(!open)}
      >
        <BellIcon level={dm && level !== 'muted' ? 'all' : level} />
      </button>
      {open && (
        <div
          className="alert-level-menu"
          role="menu"
          aria-label={`Alerts for ${name}`}
          onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
        >
          {(dm ? DM_LEVELS : CHANNEL_LEVELS).map((option) => (
            <button
              key={option}
              role="menuitemradio"
              aria-checked={option === level}
              className="alert-level-option"
              onClick={() => {
                setChannelAlerts(channelId, option)
                setOpen(false)
              }}
            >
              <span className="alert-level-label">{text(option).label}</span>
              <span className="alert-level-hint">{text(option).hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
