import { useStore } from '../store.ts'
import { BellIcon } from './alertIcons.tsx'

/**
 * Follow a stage, and in the apps, put its countdown on the lock screen.
 *
 * Following: its changeover calls buzz this person, and its countdown
 * can go on their lock screen (docs/ALERTS.md). Nobody follows a stage until
 * they choose to. Kept on the box by the stage's name, so a renamed stage
 * loses its followers.
 */
export default function FollowStageButton({ stage }: { stage: string }) {
  const boxDecides = useStore((s) => Boolean(s.config.alerts))
  const following = useStore((s) => s.alertSettings.stages.includes(stage))
  const followStage = useStore((s) => s.followStage)
  const lockScreen = useStore((s) => s.lockScreenStage)
  const setLockScreenStage = useStore((s) => s.setLockScreenStage)
  if (!boxDecides) return null
  const onLockScreen = lockScreen === stage
  return (
    <span className="stage-alert-buttons">
      {following && lockScreen !== undefined && (
        <button
          className={`icon-btn lock-screen-stage ${onLockScreen ? 'following' : ''}`}
          aria-pressed={onLockScreen}
          aria-label={`Show ${stage} on the lock screen`}
          title={onLockScreen ? 'On the lock screen' : 'Show on the lock screen'}
          onClick={() => setLockScreenStage(onLockScreen ? null : stage)}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
            <rect
              x="6"
              y="2.5"
              width="12"
              height="19"
              rx="2.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            />
            <path
              d="M12 8v4l2.5 1.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
      <button
        className={`icon-btn follow-stage ${following ? 'following' : ''}`}
        aria-pressed={following}
        aria-label={`Changeover calls for ${stage}`}
        title={following ? `Following ${stage}` : `Follow ${stage} for changeover calls`}
        onClick={() => followStage(stage, !following)}
      >
        <BellIcon level={following ? 'follow' : 'off'} />
      </button>
    </span>
  )
}
