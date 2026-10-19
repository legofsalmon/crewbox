import { useEffect, useRef, useState } from 'react'
import { HOME_CHANNEL, PANIC_CLIP_MS, type Panic } from '@crewbox/shared'
import { useStore } from '../store.ts'
import { useArmed } from '../lib/armed.ts'
import { recordClip, takeHeldHere } from '../lib/panicClip.ts'

/**
 * A call for help, at the top of every screen, for everybody, until it is
 * stood down (docs/CUES.md).
 *
 * Two audiences. Everyone else is asked one thing, whether they are going,
 * and sees who already is, so three people don't all run and nobody assumes
 * somebody else has (Social Proof, used to coordinate). The person who
 * called sees that it went, records five seconds of where they are, and
 * hears who is coming, which is the thing that helps most while they wait.
 *
 * Red, because it is the most urgent thing the app can say and nothing is
 * louder. Standing it down is armed for everyone: it takes the call off
 * every phone on site.
 */
export default function PanicBar() {
  const panics = useStore((s) => s.panics)
  if (panics.length === 0) return null
  return (
    <div className="panic-bars">
      {panics.map((panic) => (
        <PanicRow key={panic.id} panic={panic} />
      ))}
    </div>
  )
}

function PanicRow({ panic }: { panic: Panic }) {
  const meId = useStore((s) => s.me?.id)
  const panicStep = useStore((s) => s.panicStep)
  const toast = useStore((s) => s.toast)
  const mine = panic.person.id === meId
  const going = panic.responders.some((r) => r.id === meId)
  const clip = useClip(panic, mine)

  const step = (what: 'respond' | 'stand-down') => {
    if (!panicStep(panic.id, what)) toast('Can’t reach the box. Use your radio.', 'error')
  }
  const standDown = useArmed(() => step('stand-down'))
  const names = panic.responders.map((r) => r.name)
  const coming =
    names.length === 0
      ? mine
        ? 'Every phone on site is ringing.'
        : 'Nobody has said they are going yet.'
      : `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} on the way.`

  return (
    <div className="panic-bar" role="alert">
      <div className="panic-bar-text">
        <strong>{mine ? 'Help is called' : `${panic.person.name} needs help`}</strong>
        <span>{coming}</span>
        {clip === 'recording' && (
          <span className="panic-bar-rec">
            <span className="panic-bar-rec-dot" aria-hidden /> Recording 5 seconds: say where you
            are.
          </span>
        )}
        {clip === 'sent' && <span>Your recording is in #{HOME_CHANNEL}.</span>}
      </div>
      <div className="panic-bar-actions">
        {!mine && (
          <button
            className="panic-bar-going"
            aria-pressed={going}
            disabled={going}
            onClick={() => step('respond')}
          >
            {going ? 'You’re going' : 'I’m going'}
          </button>
        )}
        <button className="panic-bar-quiet" {...standDown.props}>
          {standDown.armed
            ? mine
              ? 'Stand down? Phones stop ringing'
              : `Stand down ${panic.person.name}’s call?`
            : mine
              ? 'I’m OK'
              : 'Stand down'}
        </button>
      </div>
    </div>
  )
}

/**
 * Five seconds of the caller's voice, on the device the button was held on,
 * sent into the channel the call was posted in as an ordinary file message.
 */
function useClip(panic: Panic, mine: boolean): 'recording' | 'sent' | null {
  const sendFile = useStore((s) => s.sendFile)
  const [state, setState] = useState<'recording' | 'sent' | null>(null)
  const started = useRef(false)

  useEffect(() => {
    if (!mine || started.current || !takeHeldHere()) return
    started.current = true
    setState('recording')
    void (async () => {
      const file = await recordClip(PANIC_CLIP_MS)
      if (!file) {
        setState(null)
        return
      }
      try {
        await sendFile(panic.channelId, file, 'Recorded after the panic button')
        setState('sent')
      } catch {
        setState(null)
      }
    })()
  }, [mine, panic.channelId, sendFile])

  return state
}
