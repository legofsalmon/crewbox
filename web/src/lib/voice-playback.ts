/**
 * How remote voice audio reaches the speaker.
 *
 * By default LiveKit gives every remote track its own `<audio>` element. On
 * Chrome and Firefox that is fine and it is the simpler path — the browser
 * mixes, and picking an output device is a `setSinkId` call per element.
 *
 * On iOS and Safari it is not fine. Those browsers ignore `element.volume`,
 * unlock playback per element rather than per page, and are aggressive about
 * culling media elements that go quiet — so a crew member listening to four
 * people can end up hearing one of them, or none, with nothing in the UI to
 * say so. LiveKit's answer is `webAudioMix`: every remote track is routed
 * through one AudioContext and one element instead, which is the same shape
 * a hand-rolled fix would take and is already supported by the SDK.
 *
 * It is off by default and costs something, which is why this is a decision
 * rather than a constant: with `webAudioMix` on, LiveKit switches the output
 * device by calling `setSinkId` on the *AudioContext*, and throws outright on
 * a browser that hasn't got it. That is only safe because the browsers we
 * turn this on for are exactly the browsers where we already refuse to offer
 * an output picker (see `canSelectOutput`) — so the throwing path is
 * unreachable. `mixConflictsWithOutputPicker` states that invariant so a test
 * can hold us to it rather than a comment asking to be believed.
 */

/** Safari proper — not Chrome, Edge, Opera or Firefox wearing its user agent. */
export function isSafariFrom(ua: string): boolean {
  if (!/Safari/i.test(ua)) return false
  return !/Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS/i.test(ua)
}

export function isSafari(): boolean {
  if (typeof navigator === 'undefined') return false
  return isSafariFrom(navigator.userAgent ?? '')
}

/**
 * Whether to mix remote audio through one Web Audio graph.
 *
 * Deliberately narrow: this changes how audio reaches the ear, so it is
 * turned on for the platforms with the documented fault and nowhere else.
 * Android Chrome also hides the output picker but has none of the playback
 * problems, and is left on the path that works for it today.
 */
export function shouldMixThroughWebAudio({
  ios,
  safari,
}: {
  ios: boolean
  safari: boolean
}): boolean {
  return ios || safari
}

/**
 * True when a platform would both mix through Web Audio *and* offer an
 * output picker — the combination LiveKit throws on.
 *
 * Should never be true for any real browser. It exists so the pairing is
 * checked rather than assumed: if a future browser starts reporting
 * `setSinkId` on media elements while still being Safari, this is what says
 * so, instead of a crew member discovering it when the speaker menu errors.
 */
export function mixConflictsWithOutputPicker({
  ios,
  safari,
  canSelectOutput,
}: {
  ios: boolean
  safari: boolean
  canSelectOutput: boolean
}): boolean {
  return shouldMixThroughWebAudio({ ios, safari }) && canSelectOutput
}

/**
 * WebKit's audio session: iOS 16.4 and later, in Safari and in the app's web
 * view alike. Not in TypeScript's DOM types yet.
 */
interface WebKitAudioSession {
  type: string
}

function webKitAudioSession(): WebKitAudioSession | undefined {
  if (typeof navigator === 'undefined') return undefined
  return (navigator as Navigator & { audioSession?: WebKitAudioSession }).audioSession
}

/**
 * Keep the Ring/Silent switch off the intercom for as long as the call lasts.
 *
 * WebKit picks the iPhone's audio session from what the page is doing. A
 * live microphone gets "play and record", which the Silent switch leaves
 * alone. Audio that is only Web Audio gets "ambient", which the switch mutes,
 * and with `webAudioMix` all of remote voice is Web Audio, because the
 * elements are kept muted. So crew with a microphone heard the intercom with
 * the switch on silent (a muted track is still a live capture), and crew
 * listening without one heard nothing.
 *
 * Naming the session puts everyone where the talkers already were: the
 * loudspeaker unless a headset is connected, Bluetooth allowed, the switch
 * ignored, and other audio on the phone stopped for the call. WebKit applies
 * it the next time the page's audio starts, not at once, so this has to run
 * before the room opens any.
 *
 * iOS only, which is where the switch is. Everywhere else stays WebKit's
 * choice.
 */
export function holdCallAudio({ ios }: { ios: boolean }): void {
  const session = webKitAudioSession()
  if (!ios || !session) return
  try {
    session.type = 'play-and-record'
  } catch {
    // A page on its way out can refuse. The call goes ahead either way.
  }
}

/** Back to WebKit's own choice once the call is over. */
export function releaseCallAudio(): void {
  const session = webKitAudioSession()
  if (session?.type !== 'play-and-record') return
  try {
    session.type = 'auto'
  } catch {
    // As above.
  }
}
