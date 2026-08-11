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
