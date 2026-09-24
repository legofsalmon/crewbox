import { homedir, release, userInfo } from 'node:os'
import { newId } from '@crewbox/shared'
import {
  buildCrashReport,
  buildFeedbackReport,
  hostArch,
  hostOs,
  type CrashInput,
  type FeedbackInput,
  type ReportOrigin,
} from './payload.ts'
import type { ScrubContext } from './scrub.ts'
import { ReportQueue, type QueuedReport } from './queue.ts'

/**
 * Crash reports and feedback, from this box and the phones on it, to
 * LeTissier Creative Studios — when, and only when, somebody said yes.
 *
 * The rules this file keeps (the intake contract, "client rules"):
 *
 * **Opt-in.** Crash reports go automatically only when an admin has turned on
 * "Send crash reports automatically", which starts off. Otherwise a crash is
 * queued as `pending` and the admin panel asks once; nothing leaves without
 * that answer. Feedback goes only because somebody pressed Send on it.
 *
 * **Offline first.** Everything is queued on disk (./queue.ts) and sent from
 * a timer that runs after the box is serving, with an 8 second timeout, one
 * request at a time. A box with no uplink just keeps its queue.
 *
 * **Never in the way.** Nothing here is awaited by anything crew use. A
 * failure is a line in the panel, never an exception, and never a toast.
 *
 * **Nowhere else.** One base URL, https://letissier.ie, overridable by
 * `LETISSIER_API` for tests. No third-party crash service.
 */

export const REPORTS_API = 'https://letissier.ie'

/** Settings keys. They reach real boxes: do not rename. */
export const AUTO_SEND_KEY = 'reports:autoSend'
export const INSTALL_KEY = 'reports:install'

export const SEND_TIMEOUT_MS = 8_000
/** First attempt after startup: well after the box is serving. */
export const FIRST_SEND_DELAY_MS = 45_000
/** Then this often, so a box that finds a network mid-week sends then. */
export const SEND_INTERVAL_MS = 15 * 60_000

export interface SettingsIo {
  getSetting: (key: string) => string | undefined
  setSetting: (key: string, value: string) => void
}

export type ReportFetch = (
  url: string,
  init: {
    method: 'POST'
    headers: Record<string, string>
    body: string
    signal: AbortSignal
  }
) => Promise<{ status: number }>

export interface ReportServiceOptions {
  dir: string
  settings: SettingsIo
  /** This build's version, as APP_VERSION reports it. */
  version: string
  /**
   * May this box make outbound connections? The same switch as the update
   * check (CREWBOX_UPDATE_CHECK=0). Off, reports stay queued for ever and the
   * panel says why.
   */
  outbound: boolean
  baseUrl?: string
  fetch?: ReportFetch
  log?: { info: (msg: string) => void; warn: (msg: string) => void }
  /** Overridable for tests; the real home and login name otherwise. */
  scrubContext?: ScrubContext
}

export interface PendingCrash {
  id: string
  kind: string
  summary: string
  occurredAt: string | null
}

export interface ReportsSummary {
  autoSend: boolean
  /** Crashes waiting for an admin's yes or no. */
  pending: PendingCrash[]
  /** Reports that may go and are waiting for a network. */
  waiting: number
  outbound: boolean
  lastSentAt: number | null
  lastError: string | null
}

export interface FlushResult {
  sent: number
  dropped: number
  kept: number
}

function defaultScrubContext(): ScrubContext {
  let user: string | undefined
  try {
    user = userInfo().username
  } catch {
    // No passwd entry (a container, a service account). The home dir is enough.
  }
  return { home: homedir(), ...(user ? { user } : {}) }
}

export class ReportService {
  readonly queue: ReportQueue
  private readonly options: ReportServiceOptions
  private readonly fetch: ReportFetch
  private readonly baseUrl: string
  private readonly scrubContext: ScrubContext
  private timer: NodeJS.Timeout | null = null
  private first: NodeJS.Timeout | null = null
  private flushing: Promise<FlushResult> | null = null
  /** Set by a 429: the server asked us to stop until next launch. */
  private rateLimited = false
  private lastSentAt: number | null = null
  private lastError: string | null = null

  constructor(options: ReportServiceOptions) {
    this.options = options
    this.queue = new ReportQueue(options.dir)
    this.fetch =
      options.fetch ??
      (async (url, init) => {
        const res = await fetch(url, init)
        return { status: res.status }
      })
    this.baseUrl = (options.baseUrl ?? REPORTS_API).replace(/\/+$/, '')
    this.scrubContext = options.scrubContext ?? defaultScrubContext()
  }

  /**
   * A random id for this install, made once and kept with the settings.
   *
   * Never derived from the licence, the machine, a MAC, the hostname or a
   * user name: it exists only so the studio can count how many installs a
   * crash affects and rate-limit one that is looping.
   */
  installId(): string {
    const stored = this.options.settings.getSetting(INSTALL_KEY)
    if (stored && /^[A-Za-z0-9-]{1,64}$/.test(stored)) return stored
    const id = newId()
    this.options.settings.setSetting(INSTALL_KEY, id)
    return id
  }

  autoSend(): boolean {
    return this.options.settings.getSetting(AUTO_SEND_KEY) === '1'
  }

  setAutoSend(on: boolean): void {
    this.options.settings.setSetting(AUTO_SEND_KEY, on ? '1' : '0')
  }

  /** This box, in the contract's terms. */
  private boxOrigin(): ReportOrigin {
    return {
      version: this.options.version,
      os: hostOs(),
      osVersion: safeRelease(),
      arch: hostArch(),
      install: this.installId(),
    }
  }

  /**
   * Queue a crash from this box. Sent automatically only when the admin has
   * said so; otherwise it waits for the panel's one question.
   *
   * The same crash twice (same signature, still queued) is recorded once: a
   * box that throws in a loop must not become a queue of twenty copies.
   */
  recordCrash(input: CrashInput): QueuedReport | null {
    const payload = buildCrashReport(input, this.boxOrigin(), this.scrubContext)
    const duplicate = this.queue
      .list()
      .some((e) => e.endpoint === 'crash' && e.payload.signature === payload.signature)
    if (duplicate) return null
    return this.queue.add({
      endpoint: 'crash',
      consent: this.autoSend() ? 'granted' : 'pending',
      payload,
    })
  }

  /**
   * Queue a crash a phone reported. The person on the phone pressed Send, so
   * it is granted; the phone's own version and OS are kept, because that is
   * the build that crashed.
   */
  recordClientCrash(
    input: CrashInput,
    client: { version: string; os: ReportOrigin['os']; osVersion?: string }
  ): QueuedReport | null {
    const payload = buildCrashReport(
      input,
      {
        version: client.version || this.options.version,
        os: client.os,
        ...(client.osVersion ? { osVersion: client.osVersion } : {}),
        install: this.installId(),
      },
      this.scrubContext
    )
    const entry = this.queue.add({ endpoint: 'crash', consent: 'granted', payload })
    this.soon()
    return entry
  }

  /** Queue feedback somebody pressed Send on. */
  submitFeedback(input: FeedbackInput, os: ReportOrigin['os']): QueuedReport | null {
    const payload = buildFeedbackReport(input, {
      version: this.options.version,
      os,
      install: this.installId(),
    })
    const entry = this.queue.add({ endpoint: 'feedback', consent: 'granted', payload })
    this.soon()
    return entry
  }

  pending(): PendingCrash[] {
    return this.queue
      .list()
      .filter((e) => e.consent === 'pending')
      .map((e) => ({
        id: e.id,
        kind: e.endpoint === 'crash' ? e.payload.kind : 'feedback',
        summary: e.endpoint === 'crash' ? e.payload.summary : '',
        occurredAt: e.endpoint === 'crash' ? (e.payload.occurredAt ?? null) : null,
      }))
  }

  /**
   * The admin's answer to "Crewbox closed unexpectedly last time. Send a
   * crash report?" — for every crash waiting on it. Don't send deletes them;
   * nothing about a report somebody declined stays on the box.
   */
  decide(answer: { send: boolean; always?: boolean }): ReportsSummary {
    if (answer.always) this.setAutoSend(true)
    for (const entry of this.queue.list()) {
      if (entry.consent !== 'pending') continue
      if (answer.send) this.queue.setConsent(entry.id, 'granted')
      else this.queue.remove(entry.id)
    }
    if (answer.send) this.soon()
    return this.summary()
  }

  summary(): ReportsSummary {
    const all = this.queue.list()
    return {
      autoSend: this.autoSend(),
      pending: this.pending(),
      waiting: all.filter((e) => e.consent === 'granted').length,
      outbound: this.options.outbound,
      lastSentAt: this.lastSentAt,
      lastError: this.lastError,
    }
  }

  /**
   * Send everything that may go, oldest first, one at a time.
   *
   * 202 is stored; 400 and 413 are the server saying this report will never
   * be accepted, so it is dropped rather than retried for ever; 429 means stop
   * until next launch; anything else — no network, a captive portal, a 500 —
   * keeps the report and stops this round, because the next one will fail
   * the same way.
   */
  flush(): Promise<FlushResult> {
    if (this.flushing) return this.flushing
    this.flushing = this.sendAll().finally(() => {
      this.flushing = null
    })
    return this.flushing
  }

  private async sendAll(): Promise<FlushResult> {
    const result: FlushResult = { sent: 0, dropped: 0, kept: 0 }
    const granted = this.queue.list().filter((e) => e.consent === 'granted')
    if (!this.options.outbound || this.rateLimited) {
      result.kept = granted.length
      return result
    }
    for (let i = 0; i < granted.length; i++) {
      const entry = granted[i]
      const outcome = await this.sendOne(entry)
      if (outcome === 'sent') {
        this.queue.remove(entry.id)
        result.sent++
        this.lastSentAt = Date.now()
        this.lastError = null
      } else if (outcome === 'drop') {
        this.queue.remove(entry.id)
        result.dropped++
      } else {
        result.kept += granted.length - i
        break
      }
    }
    if (result.sent > 0) this.options.log?.info(`reports: sent ${result.sent}`)
    return result
  }

  private async sendOne(entry: QueuedReport): Promise<'sent' | 'drop' | 'keep'> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS)
    try {
      const { status } = await this.fetch(`${this.baseUrl}/api/reports/${entry.endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': `Crewbox/${this.options.version} (${entry.payload.os})`,
        },
        body: JSON.stringify(entry.payload),
        signal: controller.signal,
      })
      if (status === 202 || status === 200 || status === 201) return 'sent'
      if (status === 400 || status === 413) {
        this.lastError = `the studio refused a report (${status}) and it was dropped`
        return 'drop'
      }
      if (status === 429) {
        this.rateLimited = true
        this.lastError = 'the studio asked the box to wait; it will try again after a restart'
        return 'keep'
      }
      this.lastError = `the studio answered ${status}; the box will try again later`
      return 'keep'
    } catch (err) {
      // Offline, a captive portal, DNS that answers nothing: all ordinary.
      this.lastError =
        err instanceof Error && err.name === 'AbortError'
          ? 'no answer within 8 seconds; the box will try again later'
          : 'no connection to letissier.ie; the box will try again later'
      return 'keep'
    } finally {
      clearTimeout(timer)
    }
  }

  /** Try shortly, without making anybody wait for it. */
  private soon(): void {
    if (!this.timer && !this.first) return
    const t = setTimeout(() => void this.flush(), 1_000)
    t.unref()
  }

  /** Start the background sender. Every timer is unref'd. */
  start(): void {
    if (this.first || this.timer) return
    this.first = setTimeout(() => void this.flush(), FIRST_SEND_DELAY_MS)
    this.first.unref()
    this.timer = setInterval(() => void this.flush(), SEND_INTERVAL_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.first) clearTimeout(this.first)
    if (this.timer) clearInterval(this.timer)
    this.first = null
    this.timer = null
  }
}

function safeRelease(): string | undefined {
  try {
    return release()
  } catch {
    return undefined
  }
}
