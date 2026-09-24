import { useEffect, useSyncExternalStore } from 'react'
import { eventIdFrom, type KnownEvent } from './eventScope.ts'
import { readPref, writePref } from './prefs.ts'
import { isIosApp, nativeDiscovery, type FoundService, type SearchState } from './server.ts'

/**
 * Boxes on this Wi-Fi, as the apps find them.
 *
 * A box announces `_crewbox._tcp` on its crew network (docs/DISCOVERY.md), and
 * each app's own code looks for it: NWBrowser on an iPhone, NsdManager on
 * Android (the DiscoveryPlugin beside each app's MainActivity or view
 * controller). A browser has no way to look for services at all, so the PWA
 * keeps the poster's QR.
 *
 * An announcement is a hint. Anything on the Wi-Fi can announce the service
 * with whatever details it likes, so nothing here trusts one: a box is listed
 * for a crew member to pick, and picking it asks the box itself which event
 * it runs (findBox) before anything of this device's goes there. An event
 * this device already holds is never followed to a new address on an
 * announcement's say-so, only on the box's own proof (lib/follow.ts).
 */

/** How long a search runs before the screen says nothing has answered. */
export const QUIET_AFTER_MS = 8000

/**
 * The iPhone has shown its Local Network question once.
 *
 * iOS asks the first time the app looks, and only once; there is no way to
 * ask again or to find out the answer. So the first search waits for a tap on
 * Find boxes, under a line saying why the question is coming, and every later
 * one starts by itself. A device setting, not an event's.
 */
export const ASKED_KEY = 'crewbox:find-boxes-asked'

export interface Search {
  /**
   * `off` where the app cannot look (a browser) or nothing is looking; `ask`
   * for an iPhone that has not yet asked to use the local network.
   */
  state: 'off' | 'ask' | SearchState
  /** What has been found and resolved, as the native side last said. */
  services: FoundService[]
  /** The search has run for a while with nothing found. */
  quiet: boolean
}

const OFF: Search = { state: 'off', services: [], quiet: false }

let search: Search = OFF
const listeners = new Set<() => void>()
let users = 0
let running = false
let startedAt = 0
let handles: { remove(): unknown }[] = []
let quietTimer: ReturnType<typeof setTimeout> | undefined

function update(next: Partial<Search>): void {
  search = { ...search, ...next }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const snapshot = (): Search => search

/** Whether this app can look for boxes: the apps can, a browser cannot. */
export function canSearch(): boolean {
  return !!nativeDiscovery()
}

const isPort = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) > 0 && (value as number) < 65536

/**
 * The services the native side sent, as far as they make sense. It passes
 * on what the network said, and a TXT record is anybody's to write.
 */
export function servicesFrom(value: unknown): FoundService[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): FoundService[] => {
    if (!item || typeof item !== 'object') return []
    const { name, addresses, port, txt } = item as Record<string, unknown>
    if (typeof name !== 'string' || !isPort(port) || !Array.isArray(addresses)) return []
    const record: Record<string, string> = {}
    if (txt && typeof txt === 'object') {
      for (const [key, value] of Object.entries(txt as Record<string, unknown>)) {
        if (typeof value === 'string') record[key.toLowerCase()] = value
      }
    }
    return [
      {
        name,
        addresses: addresses.filter((a): a is string => typeof a === 'string'),
        port,
        txt: record,
      },
    ]
  })
}

function armQuiet(): void {
  clearTimeout(quietTimer)
  quietTimer = setTimeout(() => {
    if (running && search.services.length === 0) update({ quiet: true })
  }, QUIET_AFTER_MS)
}

function begin(): void {
  const plugin = nativeDiscovery()
  if (!plugin || running) return
  if (isIosApp() && readPref(ASKED_KEY) !== '1') {
    update({ state: 'ask', services: [], quiet: false })
    return
  }
  // Out of sight is out of the search: it starts again when the app is back.
  if (document.visibilityState === 'hidden') return
  running = true
  startedAt = Date.now()
  handles = [
    plugin.addListener('boxes', (event) => {
      if (!running) return
      const services = servicesFrom(event?.boxes)
      update({
        services,
        quiet: services.length === 0 && Date.now() - startedAt >= QUIET_AFTER_MS,
      })
    }),
    plugin.addListener('state', (event) => {
      if (!running) return
      const state = event?.state
      if (
        state === 'searching' ||
        state === 'waiting' ||
        state === 'denied' ||
        state === 'failed'
      ) {
        update({ state })
      }
    }),
  ]
  update({ state: 'searching', services: [], quiet: false })
  armQuiet()
  plugin.start().catch(() => {
    if (running) update({ state: 'failed' })
  })
}

function end(): void {
  clearTimeout(quietTimer)
  if (!running) return
  running = false
  for (const handle of handles) {
    try {
      void handle.remove()
    } catch {
      // The page is going, or the bridge already dropped it.
    }
  }
  handles = []
  void nativeDiscovery()
    ?.stop()
    .catch(() => {})
}

function onVisibility(): void {
  if (document.visibilityState === 'hidden') end()
  else if (users > 0) begin()
}

/**
 * Look for boxes while the calling screen is showing, in the apps.
 *
 * The search runs while any screen using it is mounted and the app is on
 * screen, and stops when the last goes: looking costs battery and the
 * network's multicast. Coming back to the app starts it afresh, which is also
 * how an iPhone picks up Local Network being switched on in Settings.
 */
export function useBoxSearch(enabled = true): Search {
  useEffect(() => {
    if (!enabled || !canSearch()) return
    users++
    if (users === 1) document.addEventListener('visibilitychange', onVisibility)
    begin()
    return () => {
      users--
      if (users > 0) return
      document.removeEventListener('visibilitychange', onVisibility)
      end()
      update(OFF)
    }
  }, [enabled])
  return useSyncExternalStore(subscribe, snapshot)
}

/** The iPhone's Find boxes: the first search, which iOS asks about. */
export function searchNow(): void {
  writePref(ASKED_KEY, '1')
  begin()
}

/** The iPhone app's page in Settings, where Local Network is switched back on. */
export function openLocalNetworkSettings(): void {
  void nativeDiscovery()
    ?.openSettings?.()
    .catch(() => {})
}

// ---------------------------------------------------------------------------
// What a found box is, as a row shows it

/** A box found on the Wi-Fi, for a crew member to pick. */
export interface NearbyBox {
  /** Its service's instance name, unique on the network. */
  key: string
  /** Where it would be reached: its certificate's name over HTTPS, else its address. */
  origin: string
  /** The origin as a row shows it, without the scheme, as a poster prints it. */
  address: string
  /** The event it says it runs. A claim until the box itself is asked. */
  eventId?: string
  /** The event's name as it says it; '' when it has none. */
  eventName: string
  /** False for a new box nobody has set up, which nobody can join yet. */
  setUp: boolean
  /** Another box on the list goes by the same event or the same name. */
  lookalike: boolean
  /**
   * The name of an event this device holds that the box says it carries on
   * (its TXT record's `continues`), '' for one with no name. A claim, as the
   * rest of the announcement is: the box is asked before it is used.
   */
  carries?: string
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
/** A DNS name, and only that: it goes into a URL. */
const HOST_NAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i

/** An origin as a row shows it: without the scheme, as the join poster prints it. */
export const addressOf = (origin: string): string => origin.replace(/^https?:\/\//i, '')

/**
 * Where to reach a found box.
 *
 * A box with a certificate says so in its TXT record (`tls`), with the name
 * on the certificate when there is one, and is reached by that name over
 * HTTPS, as crew typing it would. Any other is reached at its IPv4 address
 * over plain HTTP, which the iPhone app allows for an address.
 */
export function originOf(service: FoundService): string | null {
  const ip = service.addresses.find((address) => IPV4.test(address))
  const tls = service.txt.tls
  let host: string | undefined
  let scheme = 'http'
  if (tls !== undefined) {
    scheme = 'https'
    host = tls && HOST_NAME.test(tls) ? tls.toLowerCase() : ip
  } else {
    host = ip
  }
  if (!host || !isPort(service.port)) return null
  try {
    // The URL drops a scheme's own port, as the join form's origins do.
    return new URL(`${scheme}://${host}:${service.port}`).origin
  } catch {
    return null
  }
}

const sameName = (name: string): string => name.trim().toLocaleLowerCase()

/**
 * What the list shows, from what was found and the events this device holds.
 *
 * - `boxes`: those running an event this device does not hold, one row each,
 *   the ones set up first, then by name and address. A box saying it carries
 *   on an event this device holds says which.
 * - `here`: events this device holds whose box is announcing at the very
 *   address the device knows it by, so its row can say it is on this Wi-Fi.
 *
 * An event this device holds, announced at any other address, is left out
 * altogether. Following an event to a new address has to take the box proving
 * it with the key the device kept when it joined; an announcement, or even the
 * box's own /api/config, only says so. lib/follow.ts asks the box that, and
 * once it has proven it, the event is here as the address it is known by.
 */
export function nearby(
  services: readonly FoundService[],
  known: readonly KnownEvent[]
): { boxes: NearbyBox[]; here: Set<string> } {
  const here = new Set<string>()
  const byOrigin = new Map<string, NearbyBox>()
  for (const service of services) {
    const origin = originOf(service)
    if (!origin) continue
    const eventId = eventIdFrom(service.txt.id)
    const held = eventId ? known.find((event) => event.id === eventId) : undefined
    if (held) {
      if (held.origin === origin) here.add(held.id)
      continue
    }
    if (byOrigin.has(origin)) continue
    const continues = eventIdFrom(service.txt.continues)
    const carried = continues ? known.find((event) => event.id === continues) : undefined
    byOrigin.set(origin, {
      key: service.name,
      origin,
      address: addressOf(origin),
      eventId,
      eventName: (service.txt.name ?? '').trim(),
      setUp: service.txt.setup !== '0',
      lookalike: false,
      ...(carried ? { carries: carried.name.trim() } : {}),
    })
  }
  const boxes = [...byOrigin.values()]
  for (const box of boxes) {
    box.lookalike = boxes.some(
      (other) =>
        other !== box &&
        ((box.eventId !== undefined && other.eventId === box.eventId) ||
          (box.eventName !== '' && sameName(other.eventName) === sameName(box.eventName)))
    )
  }
  // Boxes crew can join come first: one nobody has set up has no name to
  // sort by and no button, and would otherwise head the list.
  boxes.sort(
    (a, b) =>
      Number(b.setUp) - Number(a.setUp) ||
      a.eventName.localeCompare(b.eventName, undefined, { sensitivity: 'base' }) ||
      a.address.localeCompare(b.address, undefined, { numeric: true })
  )
  return { boxes, here }
}

/** Test only: forget any search, as a fresh page would. */
export function resetSearchForTests(): void {
  end()
  users = 0
  search = OFF
  document.removeEventListener('visibilitychange', onVisibility)
}
