/**
 * Links that open the app: `crewbox://join?server=…&pin=…` (lib/joinCode.ts),
 * tapped in a message or on a phone's join page (Join.tsx's "Open in the app"),
 * and `crewbox://open?event=…`, which a tapped alert opens (readOpenLink).
 *
 * Each app claims the scheme, Info.plist's CFBundleURLTypes and the manifest's
 * VIEW intent filter, and Capacitor's App plugin hands the page the link,
 * whether it started the app or came to it running. The link fills the join
 * form in, or Your boxes when this phone is signed in elsewhere. It never
 * joins and contacts nothing: a link is anybody's to send, so Join or Connect
 * is still pressed by somebody who has read what it filled in.
 */
import { readJoinLink } from './joinCode.ts'
import { nativeApp } from './server.ts'

/** What a link asked for: a box, and the event PIN when it carried one. */
export interface JoinLink {
  origin: string
  pin: string
}

let pending: JoinLink | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** The link waiting to be put in a form, or null. A new object for each link. */
export function currentJoinLink(): JoinLink | null {
  return pending
}

export function subscribeJoinLink(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Done with: filled in, or not wanted where it arrived. */
export function clearJoinLink(): void {
  if (!pending) return
  pending = null
  notify()
}

/**
 * Where a tapped alert goes (docs/ALERTS.md): a channel, the show log or a
 * stage, in one event. The Android service and the iPhone's delegate make
 * these; the event is named so a tap is never taken to the same channel id
 * in another event's box.
 */
export type OpenLink = { event: string } & (
  { to: 'channel'; channelId: string } | { to: 'showlog' } | { to: 'stage'; stage: string }
)

export function readOpenLink(link: string): OpenLink | null {
  const match = /^crewbox:\/\/open\/?\?([^#]*)$/i.exec(link.trim())
  if (!match) return null
  const params = new URLSearchParams(match[1])
  const event = params.get('event') ?? ''
  if (!event) return null
  const channelId = params.get('channel')
  if (channelId) return { event, to: 'channel', channelId }
  if (params.get('to') === 'showlog') return { event, to: 'showlog' }
  const stage = params.get('stage')
  if (stage) return { event, to: 'stage', stage }
  return null
}

let openHandler: ((link: OpenLink) => void) | null = null
let pendingOpen: OpenLink | null = null

/**
 * Where tapped alerts are taken. One that started the app arrives before
 * anything listens, so it waits here for the handler.
 */
export function handleOpenLinks(handler: (link: OpenLink) => void): void {
  openHandler = handler
  if (pendingOpen) {
    const link = pendingOpen
    pendingOpen = null
    handler(link)
  }
}

/** A link the app was handed. Anything but a join or an open link is let go. */
export function receiveLink(url: string): void {
  const open = readOpenLink(url)
  if (open) {
    if (openHandler) openHandler(open)
    else pendingOpen = open
    return
  }
  const code = readJoinLink(url)
  if (code.kind !== 'join') return
  pending = { origin: code.origin, pin: code.pin }
  notify()
}

/**
 * Whether this page is a reload rather than a fresh start of the app.
 *
 * Opening another event reloads the page (store.ts), and so does an update.
 * The link that started the app is still the one the platform reports then,
 * and it was dealt with the first time.
 */
function reloaded(): boolean {
  try {
    const [entry] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[]
    return entry?.type === 'reload'
  } catch {
    return false
  }
}

/**
 * Take links from the app, in the apps only.
 *
 * The link that started the app usually comes as appUrlOpen too: both
 * platforms' App plugins fire it for the starting link, held until the page
 * listens (Capacitor 8, `retainUntilConsumed`). getLaunchUrl is then the same
 * link again, or the only word of it if the plugin was not yet listening as
 * the app started. Android answers it with the link that started the app,
 * and an iPhone with the last link opened, for as long as the app runs.
 */
export function installAppLinks(): void {
  const app = nativeApp()
  if (!app) return
  let heard: string | null = null
  app.addListener('appUrlOpen', ({ url }) => {
    heard = url
    receiveLink(url)
  })
  if (!app.getLaunchUrl || reloaded()) return
  void app
    .getLaunchUrl()
    .then((launch) => {
      // Heard already, it has been dealt with.
      if (launch?.url && launch.url !== heard) receiveLink(launch.url)
    })
    .catch(() => {})
}
