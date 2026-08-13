/**
 * Is there a newer crewbox than this one?
 *
 * That is the whole of this file. It downloads nothing, installs nothing and
 * changes nothing — it asks the public distribution repo what the newest
 * release is, remembers the answer, and lets the tray icon and the admin
 * panel say so. Downloading and installing come later and are deliberately
 * not here: this half has no way to fail that costs anybody a show.
 *
 * Three properties matter more than the feature does:
 *
 * **It never blocks anything.** The first check runs well after the box is
 * already serving, on a timer that is unref'd, with a timeout. A box whose
 * uplink is a locked-down venue Wi-Fi behaves exactly like one that is up to
 * date, minus a line in the panel.
 *
 * **Offline is normal, not an error.** Most festival boxes have no internet
 * for days. A failed check leaves the last good answer in place rather than
 * clearing it, so a box told about v0.18 on the Thursday still says so on the
 * Saturday in a field.
 *
 * **It stores the release, not a verdict.** Whether an update is available is
 * recomputed against the running version every time it is read, so a box that
 * has since been updated stops claiming one without needing to ask again.
 */

/**
 * The public mirror, which is why no token appears anywhere here. The private
 * repo has the same releases, but reaching it would mean shipping a
 * credential inside a binary that lives in a shed.
 */
export const RELEASES_API = 'https://api.github.com/repos/legofsalmon/crewbox-dist/releases/latest'

/** Settings key holding the newest release seen. Reaches real boxes. */
export const LATEST_KEY = 'update:latest'

/** How long between checks once the box is running. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60_000

/**
 * How long after startup the first check runs.
 *
 * Not zero: a box starting up is doing the things a crew is waiting on —
 * binding, minting a PIN, printing a QR — and asking GitHub about releases is
 * not one of them.
 */
export const FIRST_CHECK_DELAY_MS = 30_000

/** A check that has not answered by now is a check nobody is waiting for. */
export const REQUEST_TIMEOUT_MS = 10_000

export interface AvailableUpdate {
  /** Tag as published, e.g. `v0.18.0`. */
  version: string
  /** The release page, for a human to read before deciding anything. */
  url: string
  publishedAt: number
}

export interface UpdateState {
  /** Newest release seen, when it is newer than the running build. */
  available: AvailableUpdate | null
  /** When the box last got an answer, or null if it never has. */
  checkedAt: number | null
  /** Why the most recent attempt failed. Reported, never thrown. */
  error: string | null
}

export interface UpdateIo {
  fetch: (
    url: string,
    init: { headers: Record<string, string>; signal: AbortSignal }
  ) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>
  now: () => number
}

export const realUpdateIo: UpdateIo = {
  fetch: (url, init) => fetch(url, init),
  now: () => Date.now(),
}

export interface SettingsIo {
  getSetting: (key: string) => string | undefined
  setSetting: (key: string, value: string) => void
}

/**
 * Major, minor and patch from a version string, or null when it isn't one.
 *
 * Accepts what both ends actually produce: `v0.18.0` from a release tag and
 * `0.18.0+a1b2c3d` from `APP_VERSION`. Everything from the first `+` or `-` is
 * dropped, which means a hypothetical `0.18.0-rc1` would compare equal to
 * `0.18.0` — harmless here, because `/releases/latest` excludes prereleases
 * and a build's own version never carries one. Worth knowing before somebody
 * relies on it for something else.
 */
export function parseVersion(value: string): [number, number, number] | null {
  const core = value.trim().replace(/^v/, '').split(/[+-]/)[0]
  const parts = core.split('.')
  if (parts.length !== 3) return null
  const nums = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : NaN))
  if (nums.some((n) => Number.isNaN(n))) return null
  return [nums[0], nums[1], nums[2]]
}

/**
 * Whether `candidate` is a later version than `current`.
 *
 * False when either side is unparseable, which is the safe direction: a box
 * built from source reports whatever package.json says, and a version nobody
 * can read should never turn into "an update is waiting for you".
 */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate)
  const b = parseVersion(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return false
}

interface CachedRelease extends AvailableUpdate {
  checkedAt: number
}

export interface UpdateCheckerOptions {
  /** This build's version, as `APP_VERSION` reports it. */
  currentVersion: string
  settings: SettingsIo
  io?: UpdateIo
  log?: { info: (msg: string) => void; warn: (msg: string) => void }
  /** Overridable so tests never reach the network. */
  url?: string
}

export class UpdateChecker {
  private readonly options: UpdateCheckerOptions
  private readonly io: UpdateIo
  private readonly url: string
  private timer: NodeJS.Timeout | null = null
  private first: NodeJS.Timeout | null = null
  private error: string | null = null
  private checking = false
  private readonly listeners: Array<(update: AvailableUpdate | null) => void> = []

  constructor(options: UpdateCheckerOptions) {
    this.options = options
    this.io = options.io ?? realUpdateIo
    this.url = options.url ?? RELEASES_API
  }

  /**
   * Be told when the answer changes.
   *
   * Registered after construction because the thing that wants to know — the
   * status file the tray helper polls — is written long after this object
   * exists, and only on a packaged box.
   */
  onAnswer(listener: (update: AvailableUpdate | null) => void): void {
    this.listeners.push(listener)
  }

  /**
   * Start checking. The first one is delayed and every timer is unref'd, so
   * this can never be the reason a box is slow to start or slow to stop.
   */
  start(): void {
    if (this.first || this.timer) return
    this.first = setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS)
    this.first.unref()
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.first) clearTimeout(this.first)
    if (this.timer) clearInterval(this.timer)
    this.first = null
    this.timer = null
  }

  /** The cached release, whatever its age. Null when nothing is stored. */
  private cached(): CachedRelease | null {
    const raw = this.options.settings.getSetting(LATEST_KEY)
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as Partial<CachedRelease>
      if (typeof parsed.version !== 'string' || typeof parsed.url !== 'string') return null
      return {
        version: parsed.version,
        url: parsed.url,
        publishedAt: typeof parsed.publishedAt === 'number' ? parsed.publishedAt : 0,
        checkedAt: typeof parsed.checkedAt === 'number' ? parsed.checkedAt : 0,
      }
    } catch {
      // Hand-edited or written by something else. Behave as if unasked.
      return null
    }
  }

  /**
   * What to show. Recomputed against the running version every time rather
   * than stored: a box that has since been updated past the cached release
   * stops advertising it without having to reach GitHub again.
   */
  state(): UpdateState {
    const cached = this.cached()
    if (!cached) return { available: null, checkedAt: null, error: this.error }
    const newer = isNewer(cached.version, this.options.currentVersion)
    return {
      available: newer
        ? { version: cached.version, url: cached.url, publishedAt: cached.publishedAt }
        : null,
      checkedAt: cached.checkedAt || null,
      error: this.error,
    }
  }

  /**
   * Ask once. Never throws and never clears a good answer on failure — a box
   * that goes offline after hearing about v0.18 should keep saying so.
   */
  async check(): Promise<UpdateState> {
    if (this.checking) return this.state()
    this.checking = true
    const before = this.state().available?.version ?? null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const res = await this.io.fetch(this.url, {
        headers: {
          accept: 'application/vnd.github+json',
          // GitHub refuses unidentified callers. Carrying the version is also
          // the only thing this request tells them that an IP does not.
          'user-agent': `crewbox/${this.options.currentVersion}`,
        },
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
      const body = (await res.json()) as {
        tag_name?: unknown
        html_url?: unknown
        published_at?: unknown
      }
      const version = typeof body.tag_name === 'string' ? body.tag_name : ''
      const url = typeof body.html_url === 'string' ? body.html_url : ''
      if (!version || !parseVersion(version)) throw new Error('no usable version in the answer')
      const publishedAt =
        typeof body.published_at === 'string' ? Date.parse(body.published_at) || 0 : 0

      this.options.settings.setSetting(
        LATEST_KEY,
        JSON.stringify({ version, url, publishedAt, checkedAt: this.io.now() })
      )
      this.error = null
      const after = this.state()
      if ((after.available?.version ?? null) !== before) {
        if (after.available) {
          this.options.log?.info(`update available: ${after.available.version}`)
        }
        for (const listener of this.listeners) {
          try {
            listener(after.available)
          } catch {
            // A listener that throws is its own bug, not a reason for the
            // check to report failure.
          }
        }
      }
      return after
    } catch (err) {
      // Every outcome here is ordinary: no uplink, a captive portal, GitHub
      // rate-limiting a whole venue's NAT. None of them is worth a warning in
      // a log somebody reads to find real problems.
      this.error =
        err instanceof Error && err.name === 'AbortError'
          ? 'the check timed out'
          : err instanceof Error
            ? err.message
            : 'the check failed'
      return this.state()
    } finally {
      clearTimeout(timer)
      this.checking = false
    }
  }
}
