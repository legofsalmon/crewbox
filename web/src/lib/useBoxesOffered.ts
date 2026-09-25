import { useSyncExternalStore } from 'react'
import { knownEvents, subscribeKnownEvents } from './eventScope.ts'
import { isNative } from './server.ts'

/**
 * Whether to offer the Boxes screen at all.
 *
 * Always in the app, which reaches boxes by address and so can be taken to
 * another. In a browser only once it holds more than one event: it is at its
 * own box's address, and a second event there is a box that came back with a
 * new database.
 */
export function useBoxesOffered(): boolean {
  const events = useSyncExternalStore(subscribeKnownEvents, knownEvents)
  return isNative() || events.length > 1
}
