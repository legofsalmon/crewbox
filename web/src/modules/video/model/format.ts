import type { ProcessorReading, ProcessorState, ProcessorStatus } from '@crewbox/shared'

/**
 * Turning a reading into the words on the row.
 *
 * Pure, and separate from the components, so the rules that matter can be
 * tested without a browser — chiefly the one about never claiming more than
 * the box actually read.
 */

/** What the box is doing, said plainly. */
export const STATE_LABELS: Record<ProcessorState, string> = {
  listed: 'Not watched',
  watching: 'Watching',
  unreachable: 'No answer',
  'no-read-path': 'Nothing to read',
}

/**
 * How the box is reading it, for the line under the name.
 *
 * Worth showing rather than hiding: SNMP and HTTP do not carry the same
 * information, and somebody looking at a sparse row deserves to know whether
 * that is the wall being quiet or the interface being thin.
 */
export function readPathLabel(reading: ProcessorReading | null): string {
  if (!reading) return ''
  if (reading.readPath === 'snmp') return 'over SNMP'
  if (reading.readPath === 'http') return 'over the HTTP API'
  return ''
}

/** "just now", "4 min ago", "2 h ago". */
export function ago(at: number | null, now: number): string {
  if (at === null) return 'never'
  const mins = Math.round((now - at) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 90) return `${mins} min ago`
  return `${Math.round(mins / 60)} h ago`
}

/**
 * The one-line detail under a processor's name.
 *
 * Built only from what was actually read. A controller that reported no
 * temperature contributes no temperature to this string rather than a zero,
 * and one that reported cabinets as normal/abnormal says so in those words
 * rather than in degrees it never gave.
 */
export function detailOf(reading: ProcessorReading | null): string {
  if (!reading) return ''
  const parts: string[] = []

  if (reading.cabinets.length > 0) {
    const offline = reading.cabinets.filter((c) => !c.online).length
    parts.push(
      offline > 0
        ? `${reading.cabinets.length - offline}/${reading.cabinets.length} cabinets online`
        : `${reading.cabinets.length} cabinets`
    )
  }

  const degrees = reading.cabinets
    .map((c) => c.temperature)
    .filter((t): t is number => t !== undefined)
  if (degrees.length > 0) parts.push(`hottest ${Math.round(Math.max(...degrees))}°C`)
  else if (reading.temperature !== undefined) parts.push(`${Math.round(reading.temperature)}°C`)

  // SNMP reports receiving cards as normal/abnormal, never as a number. Say
  // that in its own words rather than inventing a reading it never gave.
  const abnormal = reading.cabinets.filter((c) => c.tempStatus === 'abnormal').length
  if (abnormal > 0) parts.push(`${abnormal} reporting abnormal`)

  if (reading.fanFault) parts.push('a fan is abnormal')
  else if (reading.fanSpeed !== undefined) parts.push(`fans ${Math.round(reading.fanSpeed)}%`)

  const live = reading.inputs.filter((i) => i.signal === 'present').length
  const dark = reading.inputs.filter((i) => i.signal === 'no-signal').length
  if (dark > 0) parts.push(`${dark} input${dark === 1 ? '' : 's'} with no signal`)
  else if (live > 0) parts.push(`${live} input${live === 1 ? '' : 's'} live`)

  if (reading.brightness !== undefined) parts.push(`${Math.round(reading.brightness)}% brightness`)
  if (reading.isBackup) parts.push('backup controller')

  return parts.join(' · ')
}

/**
 * Whether to offer the "SNMP is off" note.
 *
 * Only when the box is reading over HTTP *and* the controller said SNMP was
 * off. Switching it on is a write, so this is advice for a human at a front
 * panel, not something crewbox will offer to do.
 */
export function shouldSuggestSnmp(status: ProcessorStatus): boolean {
  return status.reading?.readPath === 'http' && status.reading.snmpEnabled === false
}

/** Rows worth a glance first: faults, then warnings, then the rest. */
const RANK: Record<string, number> = { fault: 0, warn: 1, unknown: 2, ok: 3 }

export function byUrgency(a: ProcessorStatus, b: ProcessorStatus): number {
  // A processor nobody asked the box to watch is never urgent, whatever its
  // health grades to — it has no readings behind it.
  const aRank = a.state === 'listed' ? 4 : (RANK[a.health] ?? 2)
  const bRank = b.state === 'listed' ? 4 : (RANK[b.health] ?? 2)
  if (aRank !== bRank) return aRank - bRank
  return a.processor.name.localeCompare(b.processor.name)
}
