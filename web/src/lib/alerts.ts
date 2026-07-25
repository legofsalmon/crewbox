const SOUNDS_KEY = 'crewbox:sounds'

let audioCtx: AudioContext | null = null

export function soundsEnabled(): boolean {
  return localStorage.getItem(SOUNDS_KEY) !== 'off'
}

export function setSoundsEnabled(on: boolean): void {
  localStorage.setItem(SOUNDS_KEY, on ? 'on' : 'off')
}

function tone(freq: number, start: number, duration: number, gainValue: number): void {
  if (!audioCtx) return
  const osc = audioCtx.createOscillator()
  const gain = audioCtx.createGain()
  osc.type = 'sine'
  osc.frequency.value = freq
  const t = audioCtx.currentTime + start
  gain.gain.setValueAtTime(0, t)
  gain.gain.linearRampToValueAtTime(gainValue, t + 0.01)
  gain.gain.exponentialRampToValueAtTime(0.001, t + duration)
  osc.connect(gain).connect(audioCtx.destination)
  osc.start(t)
  osc.stop(t + duration + 0.05)
}

/**
 * Distinct, loud two-tone chirp for mentions/DMs — synthesised so there are
 * no audio assets to load (or fail to load) on the festival LAN.
 */
export function playAlert(): void {
  if (!soundsEnabled()) return
  try {
    audioCtx ??= new AudioContext()
    if (audioCtx.state === 'suspended') void audioCtx.resume()
    tone(880, 0, 0.18, 0.4)
    tone(1320, 0.12, 0.25, 0.4)
  } catch {
    // no audio available; vibration may still land
  }
  if ('vibrate' in navigator) navigator.vibrate([120, 60, 120])
}

/** Local notification when the app is backgrounded (works fully offline). */
export function notify(title: string, body: string): void {
  if (!document.hidden) return
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  try {
    new Notification(title, { body, tag: 'crewbox-msg', icon: '/icon-192.png' })
  } catch {
    // some platforms (Android Chrome) require SW-based notifications; skip
  }
}

export function requestNotificationPermission(): void {
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    void Notification.requestPermission()
  }
}

/** True when the message text @-mentions this user (or @all / @everyone). */
export function isMentioned(body: string, myName: string | undefined): boolean {
  const lower = body.toLowerCase()
  if (/@(all|everyone|channel)\b/.test(lower)) return true
  if (!myName) return false
  // Require a non-alphanumeric boundary after the name so "@Sammy" doesn't
  // mention "Sam". Names can contain regex metacharacters ("Alex (Stage 2)"),
  // so escape before building the pattern.
  const name = myName.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`@${name}(?![a-z0-9])`).test(lower)
}
