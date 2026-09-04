import { networkInterfaces } from 'node:os'
import {
  MAX_PROCESSORS,
  MAX_PROCESSOR_NAME,
  isIpv4,
  isUnicastIpv4,
  newId,
  type VideoProcessor,
} from '@crewbox/shared'
import { isOwnBroadcast } from './discovery.ts'

/**
 * The list of processors the box knows about.
 *
 * A settings row rather than a shared document, unlike most module state.
 * The reason is what the list *is*: not the crew's notes about the video
 * world but the box's own answer to "what am I allowed to contact". A Yjs
 * doc lives on phones and syncs when they turn up, which is right for a patch
 * sheet and wrong for this — a device the box talks to should not appear in
 * that list because somebody's pocket reconnected.
 *
 * So it lives on the box, an admin edits it, and every entry says who put it
 * there and who last allowed traffic to it.
 */

/** The settings key. Reaches a real box's database — do not rename it. */
export const PROCESSORS_KEY = 'video:processors'

export interface SettingsIo {
  getSetting: (key: string) => string | undefined
  setSetting: (key: string, value: string) => void
}

export class VideoStore {
  private readonly settings: SettingsIo
  private readonly now: () => number

  private readonly interfaces: typeof networkInterfaces

  constructor(
    settings: SettingsIo,
    now: () => number = Date.now,
    /** Injectable so the broadcast check is testable without a real adapter. */
    interfaces: typeof networkInterfaces = networkInterfaces
  ) {
    this.settings = settings
    this.now = now
    this.interfaces = interfaces
  }

  /**
   * Never throws and never returns junk: a settings row somebody edited by
   * hand, or one written by a newer version, degrades to whatever entries
   * still parse rather than taking the pane down.
   */
  list(): VideoProcessor[] {
    const raw = this.settings.getSetting(PROCESSORS_KEY)
    if (!raw) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return []
    }
    if (!Array.isArray(parsed)) return []
    const out: VideoProcessor[] = []
    for (const entry of parsed) {
      const p = entry as Partial<VideoProcessor>
      if (typeof p.id !== 'string' || typeof p.host !== 'string' || !isIpv4(p.host)) continue
      out.push({
        id: p.id,
        name: typeof p.name === 'string' ? p.name : p.host,
        host: p.host,
        // A processor whose `monitored` flag did not survive is treated as
        // off. Traffic is the thing that needs an affirmative answer.
        monitored: p.monitored === true,
        addedBy: typeof p.addedBy === 'string' ? p.addedBy : '',
        addedAt: typeof p.addedAt === 'number' ? p.addedAt : 0,
        ...(typeof p.armedBy === 'string' ? { armedBy: p.armedBy } : {}),
        ...(typeof p.armedAt === 'number' ? { armedAt: p.armedAt } : {}),
        source: p.source === 'scan' ? 'scan' : 'manual',
      })
      if (out.length >= MAX_PROCESSORS) break
    }
    return out
  }

  get(id: string): VideoProcessor | undefined {
    return this.list().find((p) => p.id === id)
  }

  private save(processors: VideoProcessor[]): void {
    this.settings.setSetting(PROCESSORS_KEY, JSON.stringify(processors))
  }

  /**
   * Add an address. Adding is not contacting — a new entry is never
   * monitored, so this puts nothing on the wire.
   */
  add(input: {
    host: string
    name?: string
    addedBy: string
    source?: 'manual' | 'scan'
  }): { ok: true; processor: VideoProcessor } | { ok: false; reason: string } {
    const host = input.host.trim()
    if (!isIpv4(host)) return { ok: false, reason: 'that is not an IPv4 address' }
    // One processor, addressed on purpose. Adding a group or a broadcast
    // address would turn the reader's twenty-second SNMP GET into a
    // segment-wide beacon — and adding and arming are both session-authed, so
    // this is one thing typed by anybody on site, on a box whose own rule is
    // that segment-wide traffic needs the admin password. See isUnicastIpv4.
    if (!isUnicastIpv4(host)) {
      return { ok: false, reason: 'that address is a group or a broadcast, not one processor' }
    }
    if (isOwnBroadcast(host, this.interfaces)) {
      return { ok: false, reason: 'that is the broadcast address of a network this box is on' }
    }
    const processors = this.list()
    const existing = processors.find((p) => p.host === host)
    // Idempotent by address: a scan run twice, or an address typed in that a
    // scan already found, must not produce two rows for one processor.
    if (existing) return { ok: true, processor: existing }
    if (processors.length >= MAX_PROCESSORS) {
      return { ok: false, reason: `a box holds ${MAX_PROCESSORS} processors at most` }
    }
    const processor: VideoProcessor = {
      id: newId(),
      name: (input.name ?? '').trim().slice(0, MAX_PROCESSOR_NAME) || host,
      host,
      monitored: false,
      addedBy: input.addedBy,
      addedAt: this.now(),
      source: input.source ?? 'manual',
    }
    this.save([...processors, processor])
    return { ok: true, processor }
  }

  remove(id: string): boolean {
    const processors = this.list()
    const left = processors.filter((p) => p.id !== id)
    if (left.length === processors.length) return false
    this.save(left)
    return true
  }

  rename(id: string, name: string): boolean {
    const processors = this.list()
    const target = processors.find((p) => p.id === id)
    if (!target) return false
    target.name = name.trim().slice(0, MAX_PROCESSOR_NAME) || target.host
    this.save(processors)
    return true
  }

  /**
   * Turn traffic to one processor on or off.
   *
   * `by` is recorded only when turning on, because that is the direction that
   * needs a name against it. Turning it off needs no confirmation and no
   * attribution: stopping is not a transmission, and anything that makes
   * stopping harder than starting is the wrong way round.
   */
  setMonitored(id: string, monitored: boolean, by?: string): boolean {
    const processors = this.list()
    const target = processors.find((p) => p.id === id)
    if (!target) return false
    target.monitored = monitored
    if (monitored) {
      target.armedBy = by ?? ''
      target.armedAt = this.now()
    }
    this.save(processors)
    return true
  }
}
