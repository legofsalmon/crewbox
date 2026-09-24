import { createHash } from 'node:crypto'
import { clip, scrub, type ScrubContext } from './scrub.ts'

/**
 * The two report bodies, built to the letissier.ie intake contract
 * (`POST /api/reports/crash`, `POST /api/reports/feedback`).
 *
 * Each builder copies named fields into a fresh object and nothing else, so a
 * caller that hands it more — a licence key on a crash, a crew member's name —
 * cannot get that onto the wire by accident. Every string is cut to the
 * contract's limit here, because the server answers an over-long field with
 * 400 and a 400 is dropped, not retried: a report that is two characters too
 * long would simply never arrive.
 */

export const PRODUCT = 'crewbox'

export const LIMITS = {
  version: 32,
  osVersion: 32,
  arch: 16,
  install: 64,
  summary: 300,
  detail: 32_768,
  signature: 128,
  note: 2000,
  message: 5000,
  email: 254,
  name: 100,
} as const

/** The whole body, in bytes. */
export const MAX_BODY_BYTES = 64 * 1024

export const CRASH_KINDS = [
  'panic',
  'exception',
  'signal',
  'unclean-exit',
  'gpu',
  'hang',
  'other',
] as const
export type CrashKind = (typeof CRASH_KINDS)[number]

export const OSES = ['macos', 'windows', 'linux', 'ios', 'android', 'web'] as const
export type ReportOs = (typeof OSES)[number]

export const FEEDBACK_TYPES = ['bug', 'idea', 'question', 'praise'] as const
export type FeedbackType = (typeof FEEDBACK_TYPES)[number]

export interface CrashReport {
  product: typeof PRODUCT
  version: string
  os: ReportOs
  osVersion?: string
  arch?: string
  install?: string
  kind: CrashKind
  summary: string
  detail?: string
  signature?: string
  occurredAt?: string
  note?: string
}

export interface FeedbackReport {
  product: typeof PRODUCT
  version: string
  os: ReportOs
  install?: string
  type: FeedbackType
  message: string
  email?: string
  name?: string
  licence?: string
  public?: boolean
}

/** Where a report came from: this box, or a phone talking to it. */
export interface ReportOrigin {
  version: string
  os: ReportOs
  osVersion?: string
  arch?: string
  install?: string
}

/** `process.platform` in the contract's words. */
export function hostOs(platform: NodeJS.Platform = process.platform): ReportOs {
  if (platform === 'darwin') return 'macos'
  if (platform === 'win32') return 'windows'
  return 'linux'
}

/** `process.arch` in the contract's words (`x64` is `x86_64` there). */
export function hostArch(arch: string = process.arch): string {
  return arch === 'x64' ? 'x86_64' : arch
}

const INSTALL_ID = /^[A-Za-z0-9-]{1,64}$/

/** The install id, or nothing if it is not one the server would accept. */
function installField(install: string | undefined): { install?: string } {
  return install && INSTALL_ID.test(install) ? { install } : {}
}

/**
 * A stable name for "the same crash": the kind, the first line with numbers
 * taken out, and the top few frames with line and column numbers taken out.
 * Two boxes that hit the same bug on different builds, or with a different
 * port in the message, land in the same group.
 */
export function crashSignature(kind: string, summary: string, detail?: string): string {
  const frames = (detail ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at '))
    .slice(0, 5)
    .map((line) => line.replace(/:\d+(:\d+)?\)?$/, '').replace(/0x[0-9a-f]+/gi, ''))
  const firstLine = summary.split('\n')[0].replace(/\d+/g, 'N')
  return createHash('sha256')
    .update([kind, firstLine, ...frames].join('\n'))
    .digest('hex')
    .slice(0, 16)
}

export interface CrashInput {
  kind: CrashKind
  /** The error's first line. */
  summary: string
  /** Stack trace only. */
  detail?: string
  occurredAt?: Date
  /** What the person typed about what they were doing. */
  note?: string
}

/** Build a crash report. Scrubs, cuts to the limits, and adds nothing else. */
export function buildCrashReport(
  input: CrashInput,
  origin: ReportOrigin,
  context: ScrubContext = {}
): CrashReport {
  const summaryLine = scrub(input.summary, context).split('\n')[0].trim() || 'Unknown error'
  const summary = clip(summaryLine, LIMITS.summary)
  const detail = input.detail ? clip(scrub(input.detail, context), LIMITS.detail) : undefined
  const note = input.note?.trim() ? clip(scrub(input.note.trim(), context), LIMITS.note) : undefined
  const report: CrashReport = {
    product: PRODUCT,
    version: clip(origin.version, LIMITS.version),
    os: origin.os,
    ...(origin.osVersion ? { osVersion: clip(origin.osVersion, LIMITS.osVersion) } : {}),
    ...(origin.arch ? { arch: clip(origin.arch, LIMITS.arch) } : {}),
    ...installField(origin.install),
    kind: input.kind,
    summary,
    ...(detail ? { detail } : {}),
    signature: crashSignature(input.kind, summary, detail),
    occurredAt: (input.occurredAt ?? new Date()).toISOString(),
    ...(note ? { note } : {}),
  }
  return fitBody(report)
}

export interface FeedbackInput {
  type: FeedbackType
  message: string
  email?: string
  name?: string
  /** Only when the person ticked "Include my licence so you know who I am". */
  licence?: string
  /** Only when the person ticked "OK to post this publicly". */
  public?: boolean
}

/**
 * Build a feedback report. The message is the person's own words and is sent
 * as typed (trimmed and cut to length); email, name and licence appear only
 * when given, and `public` only when true.
 */
export function buildFeedbackReport(input: FeedbackInput, origin: ReportOrigin): FeedbackReport {
  const email = input.email?.trim()
  const name = input.name?.trim()
  const licence = input.licence?.trim()
  return {
    product: PRODUCT,
    version: clip(origin.version, LIMITS.version),
    os: origin.os,
    ...installField(origin.install),
    type: input.type,
    message: clip(input.message.trim(), LIMITS.message),
    ...(email ? { email: clip(email, LIMITS.email) } : {}),
    ...(name ? { name: clip(name, LIMITS.name) } : {}),
    ...(licence ? { licence } : {}),
    ...(input.public === true ? { public: true } : {}),
  }
}

const byteLength = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')

/**
 * Keep a crash body under 64 KB. Only `detail` is ever long enough to matter,
 * and 32 768 characters of it can still be 96 KB of UTF-8, so it is trimmed
 * from the end — the top of a trace is the part anybody reads.
 */
function fitBody(report: CrashReport): CrashReport {
  if (!report.detail || byteLength(report) <= MAX_BODY_BYTES) return report
  let detail = report.detail
  while (detail.length > 0 && byteLength({ ...report, detail }) > MAX_BODY_BYTES) {
    detail = clip(detail, Math.floor(detail.length * 0.8))
  }
  const fitted: CrashReport = { ...report, detail }
  if (!detail) delete fitted.detail
  return fitted
}
