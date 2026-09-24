/**
 * Crash reports and feedback from this device, to the box.
 *
 * A phone never talks to the studio: it hands what the person agreed to send
 * to the box it is already connected to (POST /api/reports/*), and the box
 * queues it and sends it when *it* has internet — which on a festival site
 * may be days later. See server/src/reports/.
 *
 * If the box cannot be reached either, what the person pressed Send on is
 * kept here, in localStorage, and handed over the next time the app is online
 * with the box. Nothing in this file is awaited by chat, and nothing here
 * ever shows an error for a report that has not gone yet: not synced is not
 * a fault.
 */
import { readPref, writePref } from './prefs.ts'
import { apiUrl } from './server.ts'

export const FEEDBACK_TYPES = ['bug', 'idea', 'question', 'praise'] as const
export type FeedbackType = (typeof FEEDBACK_TYPES)[number]

export type ReportOs = 'ios' | 'android' | 'macos' | 'windows' | 'linux' | 'web'

/** localStorage key for reports waiting for the box. Reaches phones: do not rename. */
export const REPORT_OUTBOX_KEY = 'crewbox:report-outbox'

/** At most this many waiting on a phone; the oldest goes first. */
export const MAX_OUTBOX = 10

export interface FeedbackDraft {
  type: FeedbackType
  message: string
  email?: string
  public?: boolean
  includeLicence?: boolean
  os?: ReportOs
}

export interface ClientCrash {
  summary: string
  detail?: string
  note?: string
  version: string
  os: ReportOs
  osVersion?: string
}

type Queued =
  | { kind: 'feedback'; body: FeedbackDraft; at: number }
  | { kind: 'crash'; body: ClientCrash; at: number }

/**
 * Which platform this is, in the intake's words. The Capacitor shells say so
 * themselves; a browser is `ios` or `android` by its user agent when it
 * obviously is one, and `web` otherwise.
 */
export function clientOs(
  userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent,
  native: string | undefined = typeof window === 'undefined'
    ? undefined
    : (window as { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.()
): ReportOs {
  if (native === 'ios' || native === 'android') return native
  if (/iPhone|iPad|iPod/i.test(userAgent)) return 'ios'
  if (/Android/i.test(userAgent)) return 'android'
  return 'web'
}

/**
 * The part of a trace worth keeping from a phone: URLs lose everything after
 * `?` (a session token can ride there) and the origin — the box's address on
 * a private network — is folded to `<box>`. The box scrubs again; this is so
 * the phone never sends it at all.
 */
export function scrubClient(text: string, origin?: string): string {
  let out = text.replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>)]*)[?#][^\s"'<>)]*/gi, '$1')
  if (origin) out = out.split(origin).join('<box>')
  return out
    .replace(
      /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}\b/g,
      '<email>'
    )
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>')
}

const clip = (value: string, max: number): string =>
  value.length <= max ? value : value.slice(0, max)

/** Turn a caught render error into what the error screen offers to send. */
export function describeCrash(
  error: unknown,
  componentStack: string | undefined,
  version: string,
  origin: string | undefined = typeof location === 'undefined' ? undefined : location.origin
): ClientCrash {
  const err = error instanceof Error ? error : new Error(String(error))
  const summary = clip(scrubClient(`${err.name}: ${err.message}`, origin).split('\n')[0], 300)
  const stack = [err.stack ?? '', componentStack ? `\nComponent stack:${componentStack}` : '']
    .join('')
    .trim()
  return {
    summary: summary || 'Unknown error',
    ...(stack ? { detail: clip(scrubClient(stack, origin), 32_768) } : {}),
    version: clip(version, 32),
    os: clientOs(),
  }
}

function readOutbox(): Queued[] {
  try {
    const parsed = JSON.parse(readPref(REPORT_OUTBOX_KEY) ?? '[]') as unknown
    return Array.isArray(parsed) ? (parsed as Queued[]) : []
  } catch {
    return []
  }
}

function writeOutbox(entries: Queued[]): void {
  writePref(REPORT_OUTBOX_KEY, JSON.stringify(entries.slice(-MAX_OUTBOX)))
}

/** How many reports this device is holding for the box. */
export function waitingOnDevice(): number {
  return readOutbox().length
}

/** What happened to one report. */
export type Outcome =
  /** The box has it. */
  | 'sent'
  /** The box could not be reached; it is kept here and goes later. */
  | 'saved'
  /** The box said no, with a reason worth showing (bad input, not allowed). */
  | { refused: string }

async function post(path: string, token: string, body: unknown): Promise<Response> {
  return fetch(apiUrl(path), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/**
 * Send one report to the box, or keep it here.
 *
 * A 4xx is the box refusing *this* report — a missing message, a licence
 * tick from someone who is not an admin — and is shown, not kept: sending
 * it again would be refused again. A 404 is a box too old to have the route,
 * and anything else (offline, a 5xx) is a box that will take it later.
 */
async function deliver(entry: Queued, token: string, adminToken?: string | null): Promise<Outcome> {
  const path = entry.kind === 'feedback' ? '/api/reports/feedback' : '/api/reports/crash'
  let res: Response
  try {
    res =
      entry.kind === 'feedback' && entry.body.includeLicence && adminToken
        ? await fetch(apiUrl(path), {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              'x-admin-token': adminToken,
              'content-type': 'application/json',
            },
            body: JSON.stringify(entry.body),
          })
        : await post(path, token, entry.body)
  } catch {
    return 'saved'
  }
  if (res.ok) return 'sent'
  if (res.status >= 400 && res.status < 500 && res.status !== 404 && res.status !== 429) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    return { refused: data.error ?? `The box refused it (${res.status}).` }
  }
  return 'saved'
}

/** Send feedback, or keep it on this device until the box can take it. */
export async function sendFeedback(
  draft: FeedbackDraft,
  token: string,
  adminToken?: string | null
): Promise<Outcome> {
  const entry: Queued = {
    kind: 'feedback',
    body: { ...draft, os: draft.os ?? clientOs() },
    at: Date.now(),
  }
  const outcome = await deliver(entry, token, adminToken)
  if (outcome === 'saved') {
    // The licence tick needs an admin unlock that may have lapsed by the
    // time this goes; keep the words, drop the tick, rather than lose both.
    writeOutbox([...readOutbox(), { ...entry, body: { ...entry.body, includeLicence: false } }])
  }
  return outcome
}

/** Send the crash report the error screen offered, or keep it here. */
export async function sendCrash(crash: ClientCrash, token: string): Promise<Outcome> {
  const entry: Queued = { kind: 'crash', body: crash, at: Date.now() }
  const outcome = await deliver(entry, token)
  if (outcome === 'saved') writeOutbox([...readOutbox(), entry])
  return outcome
}

/**
 * Hand over whatever this device is holding. Called when the app is online
 * with the box; stops at the first report the box cannot take yet.
 */
export async function flushDeviceOutbox(token: string): Promise<number> {
  const waiting = readOutbox()
  let handed = 0
  for (const entry of waiting) {
    const outcome = await deliver(entry, token)
    if (outcome === 'saved') break
    handed++
  }
  if (handed > 0) writeOutbox(readOutbox().slice(handed))
  return handed
}

/**
 * The one question the admin panel asks after the box crashed, in the words
 * every LeTissier app uses. Null when nothing is waiting for an answer.
 */
export function crashQuestion(pending: ReadonlyArray<{ kind: string }>): string | null {
  if (pending.length === 0) return null
  if (pending.some((p) => p.kind === 'unclean-exit')) {
    return 'Crewbox closed unexpectedly last time. Send a crash report to LeTissier Creative Studios?'
  }
  return 'Crewbox hit an internal error and kept running. Send a crash report to LeTissier Creative Studios?'
}
