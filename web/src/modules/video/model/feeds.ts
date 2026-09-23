import type { ProcessorStatus } from '@crewbox/shared'
import type { Feed } from './screensDoc.ts'

/**
 * What the box knows about the processor input a screen is said to be fed
 * from — the sentence beside the "Fed by" menu. Pure, so the wording can be
 * tested without a browser, and honest in the same way the LED pane is: a
 * processor the box is not watching is reported as exactly that, not as a
 * wall with no signal.
 */

export interface FeedStatus {
  tone: 'ok' | 'warn' | 'fault' | 'unknown'
  text: string
}

export function feedStatus(
  feed: Feed | undefined,
  processors: ProcessorStatus[]
): FeedStatus | null {
  if (!feed) return null
  const status = processors.find((p) => p.processor.id === feed.processorId)
  if (!status) return { tone: 'unknown', text: 'processor no longer listed' }
  const name = status.processor.name || status.processor.host
  if (status.state !== 'watching') return { tone: 'warn', text: `${name} is not being watched` }
  if (!status.reading) return { tone: 'warn', text: `${name}: no reading yet` }
  const input = status.reading.inputs.find((i) => i.id === feed.inputId)
  if (!input) return { tone: 'unknown', text: `${name}: input not reported` }
  const label = input.name ?? input.id
  if (input.signal === 'present') return { tone: 'ok', text: `${name} · ${label}: signal present` }
  if (input.signal === 'no-signal') return { tone: 'fault', text: `${name} · ${label}: NO SIGNAL` }
  return { tone: 'fault', text: `${name} · ${label}: not connected` }
}
