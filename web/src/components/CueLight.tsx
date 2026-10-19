import { useEffect, useRef, useState } from 'react'
import { CUE_GO_SHOW_MS, cueWhere, isLiveCue, type Cue } from '@crewbox/shared'
import { useStore } from '../store.ts'

/** Two long buzzes for a standby, one longer for GO: told apart in a pocket. */
const STANDBY_BUZZ = [600, 200, 600]
const GO_BUZZ = [1200]

function buzz(pattern: number[]): void {
  try {
    navigator.vibrate?.(pattern)
  } catch {
    // A browser without it, or one that refuses outside a gesture: the lamp
    // is still lit.
  }
}

/**
 * The operator's cue light: their whole screen, over whatever view they are
 * in, from the moment a standby is called for them until GO has been seen.
 *
 * Who: a pyro, CO2 or playback operator, or a walk-on, in a wing or at a
 * desk, phone in hand or in a pocket, waiting. One job: say "stand by" and
 * then "go" so nobody has to read anything to know which. Amber for the
 * standby (attention, nothing is wrong yet), and GO in the green every cue
 * light in the industry uses (a departure from the system's grammar,
 * docs/CUES.md), each with the word in letters a metre away can read.
 *
 * GO stays for `CUE_GO_SHOW_MS` from when this phone saw it, never from the
 * box's clock: the box's clock and a phone's are never compared.
 */
export default function CueLight() {
  const cues = useStore((s) => s.cues)
  const meId = useStore((s) => s.me?.id)
  const cueStep = useStore((s) => s.cueStep)
  const toast = useStore((s) => s.toast)

  const mine = (cues ?? []).filter((cue) => cue.target.id === meId)
  const live = mine.filter(isLiveCue)

  // GO shows only for a cue this phone watched go, so a GO in the history a
  // welcome brings back never lights a screen.
  const watched = useRef(new Set<string>())
  const [going, setGoing] = useState<{ cue: Cue; until: number } | null>(null)
  const [hidden, setHidden] = useState<string | null>(null)

  useEffect(() => {
    for (const cue of cues ?? []) {
      if (cue.target.id !== meId) continue
      if (isLiveCue(cue)) {
        if (!watched.current.has(cue.id)) buzz(STANDBY_BUZZ)
        watched.current.add(cue.id)
      } else if (watched.current.has(cue.id)) {
        watched.current.delete(cue.id)
        if (cue.state === 'go') {
          buzz(GO_BUZZ)
          setGoing({ cue, until: Date.now() + CUE_GO_SHOW_MS })
        } else {
          toast(`${cue.label} was stood down.`, 'info')
        }
      }
    }
  }, [cues, meId, toast])

  useEffect(() => {
    if (!going) return
    const timer = setTimeout(() => setGoing(null), Math.max(0, going.until - Date.now()))
    return () => clearTimeout(timer)
  }, [going])

  // Keep the screen on while a standby waits: a phone that sleeps between
  // "stand by" and "go" is a lamp that went out.
  const lit = live.length > 0
  useEffect(() => {
    if (!lit) return
    let lock: { release(): Promise<void> } | null = null
    let gone = false
    const ask = async () => {
      try {
        const next = await navigator.wakeLock?.request('screen')
        if (gone) void next?.release()
        else lock = next ?? null
      } catch {
        // Refused (battery saver, a browser without it): the lamp still works.
      }
    }
    void ask()
    // A wake lock is let go when the page is hidden; take it back on return.
    const onVisible = () => {
      if (!document.hidden) void ask()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      gone = true
      document.removeEventListener('visibilitychange', onVisible)
      void lock?.release().catch(() => {})
    }
  }, [lit])

  const step = (cue: Cue, what: 'ready' | 'stand-down') => {
    if (!cueStep(cue.id, what)) toast('Can’t reach the box. Answer on your radio.', 'error')
  }

  if (going) {
    const { cue } = going
    return (
      <div className="cue-light cue-light-go" role="alertdialog" aria-labelledby="cue-light-word">
        <p className="cue-light-word" id="cue-light-word">
          GO
        </p>
        <p className="cue-light-label">{cue.label}</p>
        <button className="cue-light-done" onClick={() => setGoing(null)} autoFocus>
          Done
        </button>
      </div>
    )
  }

  const shown = live[0]
  if (!shown) return null
  const where = cueWhere(shown)
  const ready = shown.state === 'ready'

  if (hidden === `${shown.id}:${shown.state}`) {
    return (
      <button className="cue-light-bar" onClick={() => setHidden(null)}>
        {ready ? 'Standing by' : 'Standby'}: {shown.label}. Show the cue light
      </button>
    )
  }

  return (
    <div
      className="cue-light cue-light-standby"
      data-state={shown.state}
      role="alertdialog"
      aria-labelledby="cue-light-word"
      aria-describedby="cue-light-about"
    >
      <p className="cue-light-word" id="cue-light-word">
        {ready ? 'Standing by' : 'Standby'}
      </p>
      <p className="cue-light-label">{shown.label}</p>
      <p className="cue-light-about" id="cue-light-about">
        {ready ? `Wait for GO from ${shown.caller.name}` : `From ${shown.caller.name}`}
        {where ? ` · ${where}` : ''}
      </p>
      {live.length > 1 && (
        <p className="cue-light-about">
          {live.length - 1} more standby{live.length > 2 ? 's' : ''} after this one
        </p>
      )}
      <div className="cue-light-actions">
        {!ready && (
          <button className="cue-light-ready" onClick={() => step(shown, 'ready')} autoFocus>
            Standing by
          </button>
        )}
        {!ready && (
          <button className="cue-light-quiet" onClick={() => step(shown, 'stand-down')}>
            Can’t stand by
          </button>
        )}
        <button
          className="cue-light-quiet"
          onClick={() => setHidden(`${shown.id}:${shown.state}`)}
          {...(ready ? { autoFocus: true } : {})}
        >
          Hide
        </button>
      </div>
    </div>
  )
}
