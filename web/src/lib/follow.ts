import { useEffect, useState, useSyncExternalStore } from 'react'
import { useStore } from '../store.ts'
import { originOf } from './discovery.ts'
import {
  eventIdFrom,
  eventMoved,
  knownEvents,
  openEvent,
  subscribeKnownEvents,
  type KnownEvent,
} from './eventScope.ts'
import { eventKeyFrom, proveBox, type Proof } from './identity.ts'
import type { FoundService } from './server.ts'

/**
 * Following an event this device holds to where its box is now.
 *
 * A box can come back at another address: a new lease from the venue's
 * router, a move to another network, a spare restored from the event's
 * backup. The app goes on trying the address it has, where nothing answers or
 * something else does. Meanwhile the box is announcing itself on the Wi-Fi
 * under the event's ID (lib/discovery.ts).
 *
 * An announcement is anybody's to make, so it says only where to ask. The box
 * there is asked to sign for the event, the address and a fresh challenge with
 * the key this device kept when it joined (lib/identity.ts), and the event
 * goes only to one that does. Until then nothing of the event's goes there:
 * the question is a random challenge, and nothing else. An event with no key
 * kept is never followed on an announcement; its address can still be typed
 * in Your boxes.
 */

/**
 * How long an answer stands. A box that did not prove it is asked again after
 * this, and one that did is followed only within it: a proof from longer ago
 * says nothing about what has that address now.
 */
export const RECHECK_MS = 60_000

/** A box on the Wi-Fi announcing an event this device holds at another address. */
export interface Claim {
  event: KnownEvent
  origin: string
}

/** The claims among what the search found: events held with a key, found somewhere else. */
export function claimsOf(services: readonly FoundService[], known: readonly KnownEvent[]): Claim[] {
  const claims: Claim[] = []
  const seen = new Set<string>()
  for (const service of services) {
    const origin = originOf(service)
    const id = eventIdFrom(service.txt.id)
    if (!origin || !id) continue
    const event = known.find((held) => held.id === id)
    if (!event?.origin || event.origin === origin || !eventKeyFrom(event.key)) continue
    const key = `${id}\n${origin}`
    if (seen.has(key)) continue
    seen.add(key)
    claims.push({ event, origin })
  }
  return claims
}

/** A box's answer, or that it is being asked. */
export type Check = { result: 'checking' } | { result: Proof['kind']; at: number }

// Module-level, so a box asked from one screen is not asked again from another.
const checks = new Map<string, Check>()
const listeners = new Set<() => void>()
let version = 0
/** Which answers count: a reset leaves any still coming unwanted. */
let generation = 0

/** Per event, key kept and address: a key replaced since makes an old answer no answer. */
const checkKey = (claim: Claim): string =>
  `${claim.event.id}\n${claim.event.key ?? ''}\n${claim.origin}`

const checkOf = (claim: Claim): Check | undefined => checks.get(checkKey(claim))

function changed(): void {
  version++
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const snapshot = (): number => version

/** Ask the box at a claim's address to prove it, keeping the answer. */
function ask(claim: Claim): void {
  const key = checkKey(claim)
  const mine = generation
  checks.set(key, { result: 'checking' })
  changed()
  void proveBox(claim.origin, claim.event)
    .catch((): Proof => ({ kind: 'unchecked', reason: 'unreachable' }))
    .then((proof) => {
      if (mine !== generation) return
      checks.set(key, { result: proof.kind, at: Date.now() })
      changed()
    })
}

/**
 * What to do about the claims: which boxes to ask, and where each event goes.
 *
 * An event goes to the one address whose box has just proven it, once none of
 * the event's other claims is still being asked. Two that both prove it are
 * two copies of the event, as a box and a spare restored from its backup are,
 * and which of them the crew are on is not for a phone to guess: it stays
 * where it is until one of them has gone, or somebody types the address.
 */
export function weigh(
  claims: readonly Claim[],
  now: number,
  seen: (claim: Claim) => Check | undefined = checkOf
): { ask: Claim[]; follow: Map<string, string> } {
  const due: Claim[] = []
  const tally = new Map<string, { proven: string[]; asking: boolean }>()
  for (const claim of claims) {
    const check = seen(claim)
    const stale = !check || (check.result !== 'checking' && now - check.at >= RECHECK_MS)
    if (stale) due.push(claim)
    const event = tally.get(claim.event.id) ?? { proven: [], asking: false }
    if (stale || check.result === 'checking') event.asking = true
    else if (check.result === 'proven') event.proven.push(claim.origin)
    tally.set(claim.event.id, event)
  }
  const follow = new Map<string, string>()
  for (const [id, event] of tally) {
    if (!event.asking && event.proven.length === 1) follow.set(id, event.proven[0]!)
  }
  return { ask: due, follow }
}

/** How long until the first answer among the claims goes stale; null with none in. */
function nextStale(claims: readonly Claim[], now: number): number | null {
  let wait: number | null = null
  for (const claim of claims) {
    const check = checkOf(claim)
    if (!check || check.result === 'checking') continue
    const left = Math.max(0, check.at + RECHECK_MS - now)
    wait = wait === null ? left : Math.min(wait, left)
  }
  return wait
}

/**
 * Check the boxes found announcing events this device holds at other
 * addresses, and follow each event to the one that proves it.
 *
 * - `open`: the open event alone, which the app goes on with in place at its
 *   new address (store `followBox`). For the app while it cannot reach its
 *   box, and only then: a phone that is reaching it has nothing to follow.
 * - `others`: every other event this device holds, of which only the record
 *   changes, so Your boxes shows it on this Wi-Fi and opens it there.
 * - `off`: nothing.
 */
export function useFollowBoxes(
  services: readonly FoundService[],
  scope: 'open' | 'others' | 'off'
): void {
  const known = useSyncExternalStore(subscribeKnownEvents, knownEvents)
  const answered = useSyncExternalStore(subscribe, snapshot)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (scope === 'off') return
    const open = openEvent()
    const claims = claimsOf(services, known).filter(
      (claim) => (claim.event.id === open) === (scope === 'open')
    )
    if (claims.length === 0) return
    const now = Date.now()
    const plan = weigh(claims, now)
    for (const claim of plan.ask) ask(claim)
    for (const [id, origin] of plan.follow) {
      if (scope === 'open') useStore.getState().followBox(origin, { found: true })
      else eventMoved(id, origin)
    }
    const wait = nextStale(claims, now)
    if (wait === null) return
    const timer = setTimeout(() => setTick((n) => n + 1), wait)
    return () => clearTimeout(timer)
  }, [services, known, answered, tick, scope])
}

/** Test only: forget every answer, as a fresh page would. */
export function resetFollowForTests(): void {
  generation++
  checks.clear()
  changed()
}
