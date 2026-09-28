import type { St2110 } from '../st2110.ts'

/**
 * What the ST 2110 SDP linter makes of an SDP file a sender announced.
 *
 * An SDP file is how a receiver learns everything about a stream it is about
 * to join — the address, the format, which clock its timestamps count — and
 * a receiver handed a wrong one either refuses it or, worse, joins and shows
 * garbage. SAP announcements carry the whole file, so a passive listener can
 * check every one on the wire without asking anybody for anything.
 */

export type SdpSeverity = 'error' | 'warning'

export interface SdpProblem {
  severity: SdpSeverity
  rule: string
  message: string
  /** Line in the SDP file, from 1, when the problem has one. */
  line: number | null
}

export interface SdpStreamFacts {
  /** "video", "audio", "ancillary" and so on, as the linter recognised it. */
  essence: string
  /** The linter's one-line description: format, rate, bitrate. */
  summary: string
  destination: string | null
  /** Bits per second of pixels or samples, before headers; null if unknown. */
  bitrate: number | null
}

export interface SdpCheck {
  /**
   * An ST 2110 description, rather than an AES67 one.
   *
   * ST 2110-30 audio is AES67 with rules added, so an audio-only file only
   * counts when it says so (a `SMPTE2110` channel order). Everything else the
   * linter recognises — video, ancillary data, AES3 — is ST 2110 by nature.
   * The line matters: AES67 audio is judged by AES67, and holding it to the
   * stricter family would fill an audio rig's panel with other people's rules.
   */
  st2110: boolean
  streams: SdpStreamFacts[]
  /** Errors, then warnings, each in line order. Notes are left out. */
  problems: SdpProblem[]
}

/** Essences that are ST 2110's own; plain audio is shared with AES67. */
const ST2110_ESSENCES = new Set([
  'video',
  'compressed-video',
  'aes3',
  'ancillary',
  'fast-metadata',
  'timed-text',
  'sdi',
])

/** How many problems one file keeps. The first few say what is wrong; a
 *  file with fifty has one real fault that everything else follows from. */
export const MAX_PROBLEMS = 8

/** Lint one SDP file. */
export function checkSdp(text: string, checks: Pick<St2110, 'lint'>): SdpCheck {
  const report = checks.lint(text)
  const streams = report.streams.map((stream) => ({
    essence: stream.essence,
    summary: stream.summary,
    destination: stream.destination,
    bitrate: stream.payload_bitrate,
  }))
  const st2110 =
    streams.some((s) => ST2110_ESSENCES.has(s.essence)) ||
    (streams.some((s) => s.essence === 'audio') && /SMPTE2110/i.test(text))
  const rank = (severity: string) => (severity === 'error' ? 0 : 1)
  const problems = report.diagnostics
    .filter((d): d is typeof d & { severity: SdpSeverity } => d.severity !== 'info')
    .map((d) => ({ severity: d.severity, rule: d.rule, message: d.message, line: d.line }))
    .sort((a, b) => rank(a.severity) - rank(b.severity) || (a.line ?? 0) - (b.line ?? 0))
    .slice(0, MAX_PROBLEMS)
  return { st2110, streams, problems }
}

/** "2.07 Gb/s", "36.9 Mb/s": bitrates as a video engineer writes them. */
export function bitrate(bits: number): string {
  if (bits >= 1e9) return `${(bits / 1e9).toFixed(2)} Gb/s`
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)} Mb/s`
  return `${Math.round(bits / 1e3)} kb/s`
}
