import type {
  AudioReport,
  CaptureFinding,
  CaptureReport,
  CaptureTimescale,
  CinstReport,
  Diagnostic,
  Essence,
  FlowReport,
  PtpDomainReport,
  Report,
  Severity,
  Stats,
  Stream,
  VideoReport,
  VrxReport,
} from '@crewbox/st2110'
import type { CaptureSdp } from '../../../lib/st2110Capture.ts'

/**
 * What the Network page's ST 2110 checks say (ui/St2110Checks.tsx): the SDP
 * linter's report laid over the file it read, and the capture analyser's
 * report in the sentences `st2110 pcap` prints, so the page and the command
 * line agree about a capture.
 */

export interface Verdict {
  state: 'ok' | 'limited' | 'off'
  words: string
}

/** The words the rest of the page uses for the checks' severities. */
export const SEVERITY_WORDS: Record<Severity, string> = {
  error: 'Fault',
  warning: 'Warning',
  info: 'Note',
}

const RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 }

/** The standard each kind of stream is sent under, as the checks name them. */
export const STANDARD: Record<Essence, string> = {
  video: 'ST 2110-20',
  'compressed-video': 'ST 2110-22',
  audio: 'ST 2110-30',
  aes3: 'ST 2110-31',
  ancillary: 'ST 2110-40',
  'fast-metadata': 'ST 2110-41',
  'timed-text': 'ST 2110-43',
  sdi: 'ST 2022-6',
  unknown: 'not ST 2110',
}

/** "1 flow", "12,000 packets". */
export function count(n: number, noun: string, many = `${noun}s`): string {
  return `${n.toLocaleString('en-GB')} ${n === 1 ? noun : many}`
}

/** A file's size as capture tools print it, in decimal units: "241 kB", "1.2 GB". */
export function size(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`
  const units = ['kB', 'MB', 'GB', 'TB']
  let value = bytes / 1000
  let unit = 0
  while (value >= 999.5 && unit < units.length - 1) {
    value /= 1000
    unit++
  }
  return `${value < 9.95 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

const sentence = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

interface Tally {
  errors: number
  warnings: number
  notes: number
}

function tally(items: readonly { severity: Severity }[]): Tally {
  const found = { errors: 0, warnings: 0, notes: 0 }
  for (const { severity } of items) {
    if (severity === 'error') found.errors++
    else if (severity === 'warning') found.warnings++
    else found.notes++
  }
  return found
}

/** "2 faults, 1 note": only what there is. */
function tallyWords({ errors, warnings, notes }: Tally): string {
  const words: string[] = []
  if (errors > 0) words.push(count(errors, 'fault'))
  if (warnings > 0) words.push(count(warnings, 'warning'))
  if (notes > 0) words.push(count(notes, 'note'))
  return words.join(', ')
}

/** An address and port, with an IPv6 address bracketed so the port reads as one. */
const endpoint = (address: string, port: number | null): string =>
  port === null ? address : address.includes(':') ? `[${address}]:${port}` : `${address}:${port}`

/* ------------------------------------------------------------ SDP files */

/** No SDP file is anywhere near this; a file that is, is something else. */
export const MAX_SDP_BYTES = 64 * 1024

/** One line of an SDP file, with what the linter said of it. */
export interface SdpLine {
  number: number
  text: string
  /** The stream this line's m= starts, when it starts one. */
  stream: Stream | null
  diagnostics: Diagnostic[]
}

export interface AnnotatedSdp {
  /** What was said of the file as a whole, which no one line carries. */
  general: Diagnostic[]
  lines: SdpLine[]
}

/**
 * The file as the linter numbered it (`parse_into` in st2110's sdp.rs): a
 * byte-order mark dropped, split at each line feed with any carriage return
 * before it, and blank lines at the end left off. Each finding goes under
 * the line it is about, so the page can go through a copy line by line.
 */
export function annotateSdp(text: string, report: Report): AnnotatedSdp {
  const body = text.startsWith('\uFEFF') ? text.slice(1) : text
  const raw = body.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
  let end = raw.length
  while (end > 0 && raw[end - 1].trim() === '') end--
  const lines: SdpLine[] = raw
    .slice(0, end)
    .map((text, i) => ({ number: i + 1, text, stream: null, diagnostics: [] }))
  for (const stream of report.streams) {
    const line = lines[stream.line - 1]
    if (line) line.stream = stream
  }
  const general: Diagnostic[] = []
  for (const diagnostic of report.diagnostics) {
    const line = diagnostic.line === null ? undefined : lines[diagnostic.line - 1]
    if (line) line.diagnostics.push(diagnostic)
    else general.push(diagnostic)
  }
  return { general, lines }
}

/** "Stream 1, ST 2110-20, to 239.10.10.1:5004: 1920x1080 progressive, 50 fps, …". */
export function streamWords(stream: Stream): string {
  const to = stream.destination ? `, to ${endpoint(stream.destination, stream.port)}` : ''
  return `Stream ${stream.index + 1}, ${STANDARD[stream.essence]}${to}: ${stream.summary}`
}

export function sdpVerdict(report: Report): Verdict {
  const found = tally(report.diagnostics)
  const words = tallyWords(found)
  const streams = report.streams.length
  if (found.errors > 0) {
    return {
      state: 'off',
      words:
        streams > 0
          ? `${words} in ${count(streams, 'stream')}.`
          : `${words}, and no streams in it.`,
    }
  }
  const rest = words ? `; ${words}` : ''
  if (streams === 0) return { state: 'limited', words: `No streams in it${rest}.` }
  return {
    state: found.warnings > 0 ? 'limited' : 'ok',
    words: `Nothing a receiver would refuse in ${count(streams, 'stream')}${rest}.`,
  }
}

/* ------------------------------------------------------------- captures */

/**
 * The largest capture the page will take. The analyser reads the whole file
 * at once, so a browser tab holds it twice over (the file, and the
 * analyser's copy), and past this a phone or a small laptop runs out.
 */
export const MAX_CAPTURE_BYTES = 1024 ** 3

/** What a chosen or dropped file turned out to be. */
export type Picked =
  | { kind: 'capture'; file: File }
  | { kind: 'sdp'; sdp: CaptureSdp }
  | { kind: 'refused'; why: string }

/** pcap (microsecond and nanosecond, either byte order) and pcapng. */
const CAPTURE_MAGIC = ['a1b2c3d4', 'd4c3b2a1', 'a1b23c4d', '4d3cb2a1', '0a0d0d0a']

/**
 * Tell a capture from an SDP file by what is in it, not by its name: capture
 * tools save under all sorts of extensions, and a phone's file picker often
 * has no type to go on at all.
 */
export async function identify(file: File): Promise<Picked> {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer())
  const magic = Array.from(head, (b) => b.toString(16).padStart(2, '0')).join('')
  if (CAPTURE_MAGIC.includes(magic)) return { kind: 'capture', file }
  if (file.size <= MAX_SDP_BYTES) {
    const text = await file.text()
    if (/^\uFEFF?\s*v=/.test(text)) return { kind: 'sdp', sdp: { name: file.name, text } }
    return { kind: 'refused', why: `${file.name} is not an SDP file or a pcap or pcapng capture.` }
  }
  return {
    kind: 'refused',
    why: `${file.name} is ${size(file.size)}: too big for an SDP file, and not a pcap or pcapng capture.`,
  }
}

/** Why a capture is more than the page will take, or null when it is not. */
export function captureTooBig(file: File): string | null {
  if (file.size <= MAX_CAPTURE_BYTES) return null
  return (
    `${file.name} is ${size(file.size)}, more than a browser can be asked to hold. ` +
    'Cut it down with editcap, or check it with the st2110 command on a computer.'
  )
}

export function captureVerdict(report: CaptureReport): Verdict {
  const found = tally(report.findings)
  // As `st2110 pcap` counts it: a file that stops partway is a fault.
  if (report.capture.error) found.errors++
  const words = tallyWords(found)
  const flows = count(report.flows.length, 'RTP flow')
  if (found.errors > 0) return { state: 'off', words: `${words} in ${flows}.` }
  const rest = words ? `; ${words}` : ''
  if (report.flows.length === 0) return { state: 'limited', words: `No RTP flows in it${rest}.` }
  return { state: found.warnings > 0 ? 'limited' : 'ok', words: `No faults in ${flows}${rest}.` }
}

/** "pcapng, 12,000 frames over 1.990 s (15.6 MB): 11,960 RTP packets in 3 flows, 40 PTP messages." */
export function captureFacts({ capture, flows }: CaptureReport): string {
  return (
    `${capture.format}, ${count(capture.frames, 'frame')} over ${capture.duration.toFixed(3)} s ` +
    `(${size(capture.bytes)}): ${count(capture.rtp, 'RTP packet')} in ${count(flows.length, 'flow')}, ` +
    `${count(capture.ptp, 'PTP message')}.`
  )
}

/** Which clock the capture's timestamps count, and how that was decided. */
export function clockWords({ clock, basis, shift }: CaptureTimescale): string {
  const what =
    clock === 'ptp'
      ? 'PTP time'
      : clock === 'utc'
        ? `UTC, moved ${Math.trunc(shift / 1e9)} s onto PTP time`
        : 'unknown'
  return `The capture's clock is ${what}: ${basis}.`
}

/** What limits the measurements, when something does, as a sentence. */
export const clockNote = ({ note }: CaptureTimescale): string | null =>
  note ? `${sentence(note)}.` : null

/** A frame rate as people say it: "50", "29.97". */
function rate(text: string): string {
  const [num, den] = text.split('/').map(Number)
  if (!num || !den) return text
  return String(Math.round((num / den) * 100) / 100)
}

/** A measurement's mean, then its range. */
const range = (stats: Stats, unit: string): string =>
  `${stats.mean.toFixed(1)}${unit} (${stats.min.toFixed(1)} to ${stats.max.toFixed(1)})`

function cinstWords(cinst: CinstReport): string {
  let text = `CINST peaked at ${cinst.peak}`
  if (cinst.cmax !== null && cinst.signalled_cmax !== null) {
    text += `, CMAX ${cinst.cmax} as the SDP file signals`
  } else if (cinst.cmax !== null && cinst.sender_type) {
    text += `, CMAX ${cinst.cmax} for ${cinst.sender_type}`
  } else if (cinst.cmax === null && cinst.sender_type && cinst.signalled_cmax === null) {
    text += `, no CMAX for ${cinst.sender_type} at this packet rate`
  }
  return `${text}; fits ${cinst.fits.length > 0 ? cinst.fits.join(', ') : 'no sender type'}`
}

function vrxWords(vrx: VrxReport): string {
  let text =
    `Virtual receiver buffer peaked at ${vrx.peak} of VRXFULL ${vrx.vrxfull}, ` +
    `${vrx.schedule} reads from TROFFSET ${vrx.troffset_us.toFixed(1)} µs` +
    (vrx.troffset_signalled ? ' as signalled' : '')
  const margin = vrx.margin_us
  if (margin) {
    text +=
      margin.min < 0
        ? `; packets arrived as much as ${(-margin.min).toFixed(1)} µs after their reads`
        : `; packets arrived ${margin.min.toFixed(1)} µs or more before their reads`
  }
  if (vrx.underflows > 0) text += `, ${count(vrx.underflows, 'underflow')}`
  if (vrx.overflows > 0) text += `, ${count(vrx.overflows, 'overflow')}`
  return text
}

function videoLines(essence: Essence, video: VideoReport): string[] {
  const parts: string[] = []
  if (essence !== 'ancillary') {
    parts.push(video.height === null ? 'lines unknown' : `${video.height} lines`)
    parts.push(
      video.segmented ? 'segmented frames' : video.interlaced ? 'interlaced' : 'progressive'
    )
  }
  if (video.frame_rate) parts.push(`${rate(video.frame_rate)} frames a second`)
  parts.push(count(video.units, video.interlaced && !video.segmented ? 'field' : 'frame'))
  const packets = video.packets_per_frame
  if (packets) {
    parts.push(
      packets.min === packets.max
        ? `${packets.min} packets a frame`
        : `${packets.min} to ${packets.max} packets a frame`
    )
  }
  const lines = [`${essence === 'ancillary' ? 'Ancillary data' : 'Video'}: ${parts.join(', ')}`]
  const measured: string[] = []
  if (video.fpt) measured.push(`first packet time ${range(video.fpt, ' µs')}`)
  if (video.rtp_offset) measured.push(`RTP offset ${range(video.rtp_offset, ' ticks')}`)
  if (video.latency) measured.push(`latency ${range(video.latency, ' µs')}`)
  if (measured.length > 0) lines.push(sentence(measured.join(', ')))
  if (video.cinst) lines.push(cinstWords(video.cinst))
  if (video.vrx) lines.push(vrxWords(video.vrx))
  if (video.models_skipped) lines.push(`ST 2110-21 models not run: ${video.models_skipped}`)
  if (video.vrx_skipped) lines.push(`Virtual receiver buffer not modelled: ${video.vrx_skipped}`)
  return lines
}

function audioLines(audio: AudioReport): string[] {
  const parts = [audio.encoding, `${audio.sample_rate / 1000} kHz`]
  if (audio.channels !== null) parts.push(count(audio.channels, 'channel'))
  if (audio.samples_per_packet !== null) {
    const time = audio.packet_time_us === null ? '' : ` (${audio.packet_time_us.toFixed(1)} µs)`
    parts.push(`${count(audio.samples_per_packet, 'sample')} a packet${time}`)
  }
  const lines = [`Audio: ${parts.join(', ')}`]
  const measured: string[] = []
  if (audio.latency) measured.push(`latency ${range(audio.latency, ' µs')}`)
  if (audio.interval) measured.push(`packet interval ${range(audio.interval, ' µs')}`)
  if (audio.ts_df) measured.push(`TS-DF at most ${audio.ts_df.max.toFixed(1)} µs`)
  if (measured.length > 0) lines.push(sentence(measured.join(', ')))
  return lines
}

/** A heading, then the lines under it. */
export interface Described {
  heading: string
  details: string[]
}

export function describeFlow(flow: FlowReport): Described {
  const what = flow.sdp
    ? `${STANDARD[flow.essence]}, ${flow.sdp}`
    : flow.essence === 'unknown'
      ? 'not recognised as ST 2110'
      : `${STANDARD[flow.essence]} by its packets`
  let counts = `${count(flow.packets, 'packet')} (payload type ${flow.payload_type}, SSRC ${flow.ssrc})`
  if (flow.mbps !== null) counts += ` at ${flow.mbps.toFixed(1)} Mb/s`
  if (flow.lost > 0) counts += `, ${flow.lost.toLocaleString('en-GB')} lost`
  if (flow.out_of_order > 0) counts += `, ${flow.out_of_order.toLocaleString('en-GB')} out of order`
  if (flow.duplicates > 0) counts += `, ${flow.duplicates.toLocaleString('en-GB')} duplicated`
  return {
    heading: `Flow ${flow.index}: ${flow.source} to ${flow.destination}, ${what}`,
    details: [
      counts,
      ...(flow.video ? videoLines(flow.essence, flow.video) : []),
      ...(flow.audio ? audioLines(flow.audio) : []),
    ],
  }
}

export function describePtpDomain(domain: PtpDomainReport): Described {
  const named = domain.grandmasters
  const grandmasters =
    named.length === 0
      ? 'no Announce messages'
      : `${named.length === 1 ? 'grandmaster' : 'grandmasters'} ${named.join(', ')}`
  const details = domain.ports.map((port) => {
    const messages = port.messages.map(({ kind, count: n, interval_ms }) =>
      interval_ms
        ? `${n.toLocaleString('en-GB')} ${kind} every ${interval_ms.mean.toFixed(1)} ms`
        : `${n.toLocaleString('en-GB')} ${kind}`
    )
    return `${port.port} at ${port.address}: ${messages.join(', ')}`
  })
  if (domain.sync_offset_us) {
    details.push(`Sync arrival less departure ${range(domain.sync_offset_us, ' µs')}`)
  }
  return { heading: `PTP domain ${domain.domain}: ${grandmasters}`, details }
}

/** Faults first, then warnings, then notes; the analyser's order within each. */
export const sortFindings = (findings: readonly CaptureFinding[]): CaptureFinding[] =>
  [...findings].sort((a, b) => RANK[a.severity] - RANK[b.severity])

/** Where and when: "Flow 1 (to 239.10.10.2:5006), first at 0.052 s, 200 times". */
export function findingWhere(finding: CaptureFinding, flows: readonly FlowReport[]): string {
  const parts: string[] = []
  if (finding.flow !== null) {
    const flow = flows.find((f) => f.index === finding.flow)
    parts.push(flow ? `Flow ${finding.flow} (to ${flow.destination})` : `Flow ${finding.flow}`)
  } else if (finding.domain !== null) {
    parts.push(`PTP domain ${finding.domain}`)
  }
  if (finding.at !== null) {
    parts.push(`${parts.length > 0 ? 'first' : 'First'} at ${finding.at.toFixed(3)} s`)
  }
  if (finding.count > 1) parts.push(count(finding.count, 'time'))
  return parts.join(', ')
}
