import { levelFor, type ChannelAlertLevel } from '@crewbox/shared'
import { useStore, channelLabel } from '../store.ts'
import { useStageNames } from '../shell/timetable/hooks.ts'
import { LEVEL_TEXT, DM_LEVELS, CHANNEL_LEVELS, dmText } from '../lib/alertLevels.ts'

/**
 * "Alerts…": everything that decides what buzzes this person's pocket, on
 * one screen (docs/ALERTS.md). Each channel's level, and the stages whose
 * changeover calls they follow.
 *
 * All of it is kept on the box, so it follows the person to every device
 * they use and reaches the iPhone's alerts, which can't read this page.
 * Show stops, holds and the production desk aren't listed: those reach
 * everybody, which is the point of them.
 */
export default function AlertSettingsDialog({ onClose }: { onClose: () => void }) {
  const me = useStore((s) => s.me)
  const users = useStore((s) => s.users)
  const channels = useStore((s) => s.channels)
  const settings = useStore((s) => s.alertSettings)
  const setChannelAlerts = useStore((s) => s.setChannelAlerts)
  const followStage = useStore((s) => s.followStage)
  const stageNames = useStageNames()

  const listed = Object.values(channels)
    .filter((c) => !c.retired && (c.kind === 'public' || c.memberIds?.includes(me?.id ?? '')))
    .map((c) => ({ channel: c, label: channelLabel(c, users, me?.id) }))
    .sort((a, b) =>
      a.channel.kind === b.channel.kind
        ? a.label.localeCompare(b.label)
        : a.channel.kind === 'public'
          ? -1
          : 1
    )
  // A followed stage that has left the running order stays listed, so it can be let go.
  const stages = [...new Set([...stageNames, ...settings.stages])]

  return (
    <div
      className="search-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div className="confirm-panel alert-settings-panel" role="dialog" aria-label="Alerts">
        <h3>Alerts</h3>
        <p>
          What buzzes your phone. Show stops, holds and the production desk always reach everyone.
        </p>
        <h4>Channels</h4>
        {listed.length === 0 ? (
          <p className="alert-settings-empty">No channels yet.</p>
        ) : (
          <ul className="alert-settings-list">
            {listed.map(({ channel, label }) => {
              const dm = channel.kind === 'dm'
              const level = levelFor(settings, channel.id)
              return (
                <li key={channel.id} className="alert-settings-row">
                  <label htmlFor={`alert-level-${channel.id}`}>{dm ? label : `#${label}`}</label>
                  <select
                    id={`alert-level-${channel.id}`}
                    value={dm && level === 'all' ? 'mentions' : level}
                    onChange={(e) =>
                      setChannelAlerts(channel.id, e.target.value as ChannelAlertLevel)
                    }
                  >
                    {(dm ? DM_LEVELS : CHANNEL_LEVELS).map((option) => (
                      <option key={option} value={option}>
                        {dm ? dmText(option).label : LEVEL_TEXT[option].label}
                      </option>
                    ))}
                  </select>
                </li>
              )
            })}
          </ul>
        )}
        <h4>Changeover calls</h4>
        {stages.length === 0 ? (
          <p className="alert-settings-empty">
            No stages in the running order yet. Follow one here or on the schedule once it has acts.
          </p>
        ) : (
          <ul className="alert-settings-list">
            {stages.map((stage) => (
              <li key={stage} className="alert-settings-row">
                <label className="feedback-tick">
                  <input
                    type="checkbox"
                    checked={settings.stages.includes(stage)}
                    onChange={(e) => followStage(stage, e.target.checked)}
                  />
                  {stage}
                </label>
              </li>
            ))}
          </ul>
        )}
        <p className="alert-settings-note">
          A followed stage calls when each changeover starts, 5 minutes before the next act, and
          when a set moves in the next two hours.
        </p>
        <div className="confirm-actions">
          <button className="confirm-send" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
