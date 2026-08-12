import {
  COEX_HTTP_PORT,
  SNMP_PORT,
  type VideoAction,
  type VideoIntent,
  type VideoProcessor,
} from '@crewbox/shared'
import { Intents } from './intents.ts'
import { VideoStore, type SettingsIo } from './store.ts'
import { VideoWatcher, type WatcherIo } from './watcher.ts'
import { LISTEN_MS, realScanIo, scan, type ScanIo } from './discovery.ts'

/**
 * Everything the video module owns, behind one object.
 *
 * The routes in app.ts are deliberately thin over this: what may transmit,
 * and under what conditions, is a property of this file rather than something
 * spread across a dozen handlers.
 */

export interface ScanRun {
  at: number
  by: string
  /** Verbatim, in words somebody can check against a packet capture. */
  sent: string[]
  /** Addresses that answered. Not added to the list — an admin does that. */
  found: Array<{ host: string; payload?: string; known: boolean }>
  errors: string[]
}

export interface VideoServiceOptions {
  settings: SettingsIo
  /** Video-network interface IP. Without one there is nothing to scan on. */
  interfaceIp?: string
  community?: string
  io?: WatcherIo
  scanIo?: ScanIo
  now?: () => number
  log?: { warn: (msg: string) => void }
}

export class VideoService {
  readonly store: VideoStore
  readonly watcher: VideoWatcher
  readonly intents: Intents
  readonly interfaceIp: string
  private readonly scanIo: ScanIo
  private readonly now: () => number
  private scanning = false
  private lastScan: ScanRun | null = null

  constructor(options: VideoServiceOptions) {
    this.now = options.now ?? Date.now
    this.store = new VideoStore(options.settings, this.now)
    this.watcher = new VideoWatcher({
      store: this.store,
      ...(options.io ? { io: options.io } : {}),
      ...(options.community ? { community: options.community } : {}),
      ...(options.log ? { log: options.log } : {}),
    })
    this.intents = new Intents(this.now)
    this.interfaceIp = options.interfaceIp ?? ''
    this.scanIo = options.scanIo ?? realScanIo
  }

  start(): void {
    this.watcher.start()
  }

  stop(): void {
    this.watcher.stop()
  }

  get busy(): boolean {
    return this.scanning
  }

  get lastScanRun(): ScanRun | null {
    return this.lastScan
  }

  /** Whether a scan is even possible. Without an interface there is nothing to sweep. */
  get canScan(): boolean {
    return this.interfaceIp !== ''
  }

  /**
   * Describe an action without doing it — the first half of the double
   * confirmation. The words returned are what the admin has to accept, so
   * they say what goes on the wire rather than what the button is called.
   */
  describe(input: {
    userId: string
    action: VideoAction
    processor?: VideoProcessor
  }): { ok: true; intent: VideoIntent } | { ok: false; reason: string } {
    if (input.action === 'scan') {
      if (!this.canScan) {
        return {
          ok: false,
          reason: 'this box has no video-network interface set (CREWBOX_VIDEO_IFACE)',
        }
      }
      return {
        ok: true,
        intent: this.intents.arm({
          userId: input.userId,
          action: 'scan',
          target: `the ${this.interfaceIp} network`,
          willSend: [
            'One 8-byte UDP packet, "rqProMI:", to the subnet broadcast address on port 3800',
            'The same packet to the multicast group 224.224.125.119 on port 3800',
            `Then ${LISTEN_MS / 1000} seconds of listening. Nothing else is sent`,
          ],
        }),
      }
    }

    const processor = input.processor
    if (!processor) return { ok: false, reason: 'no such processor' }
    return {
      ok: true,
      intent: this.intents.arm({
        userId: input.userId,
        action: 'watch',
        processorId: processor.id,
        target: `${processor.name} (${processor.host})`,
        // Packets only. The dialog says "reads only" in its own words right
        // underneath, and saying it twice in a row reads as protesting.
        willSend: [
          `SNMP GET requests to ${processor.host}:${SNMP_PORT}, about every 20 seconds`,
          `Or, if SNMP is off, HTTP GET requests to ${processor.host}:${COEX_HTTP_PORT}`,
          'Nothing else, and nothing until you stop it',
        ],
      }),
    }
  }

  /**
   * Sweep for processors.
   *
   * The caller has already spent an intent to get here. Results are reported
   * and nothing is added to the list — finding an address and deciding the
   * box may talk to it are separate decisions, and the second one is another
   * confirmation away.
   */
  async runScan(by: string): Promise<ScanRun> {
    if (this.scanning) throw new Error('a scan is already running')
    this.scanning = true
    try {
      const result = await scan(this.interfaceIp, this.scanIo)
      const known = new Set(this.store.list().map((p) => p.host))
      const run: ScanRun = {
        at: this.now(),
        by,
        sent: result.sent,
        found: result.found.map((f) => ({ ...f, known: known.has(f.host) })),
        errors: result.errors,
      }
      this.lastScan = run
      return run
    } finally {
      this.scanning = false
    }
  }
}
