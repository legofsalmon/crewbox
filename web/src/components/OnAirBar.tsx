import { useStore } from '../store.ts'

/**
 * Who is live on camera.
 *
 * Two audiences, one bar. If it is you, this is the only thing on your screen
 * that matters and it says so in the loudest way the app has — you are about
 * to be looked at, and you should not have to read anything to find that out.
 * If it is somebody else, it is worth knowing quietly, because "don't call
 * Dev, he's live" is exactly the sort of thing crews get wrong over comms.
 *
 * Raised from a vision desk through the control API, never from inside the
 * app: the person on camera is the last person who should be tapping a phone,
 * and the mixer already knows before anybody else does.
 */
export default function OnAirBar() {
  const onAir = useStore((s) => s.onAir)
  const users = useStore((s) => s.users)
  const me = useStore((s) => s.me)

  if (!onAir) return null

  const mine = onAir === me?.id
  const who = users[onAir]?.name ?? 'Someone'

  return (
    <div className={`on-air ${mine ? 'on-air-me' : ''}`} role="status" aria-live="assertive">
      <span className="on-air-dot" aria-hidden />
      {mine ? 'ON AIR — you are live' : `On air: ${who}`}
    </div>
  )
}
