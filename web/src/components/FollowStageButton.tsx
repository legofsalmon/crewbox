import { useStore } from '../store.ts'
import { BellIcon } from './alertIcons.tsx'

/**
 * Follow a stage: its changeover calls buzz this person, and its countdown
 * can go on their lock screen (docs/ALERTS.md). Nobody follows a stage until
 * they choose to. Kept on the box by the stage's name, so a renamed stage
 * loses its followers.
 */
export default function FollowStageButton({ stage }: { stage: string }) {
  const boxDecides = useStore((s) => Boolean(s.config.alerts))
  const following = useStore((s) => s.alertSettings.stages.includes(stage))
  const followStage = useStore((s) => s.followStage)
  if (!boxDecides) return null
  return (
    <button
      className={`icon-btn follow-stage ${following ? 'following' : ''}`}
      aria-pressed={following}
      aria-label={`Changeover calls for ${stage}`}
      title={following ? `Following ${stage}` : `Follow ${stage} for changeover calls`}
      onClick={() => followStage(stage, !following)}
    >
      <BellIcon level={following ? 'follow' : 'off'} />
    </button>
  )
}
