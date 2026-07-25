/**
 * Minimal shell-owned history router. The URL is the single source of truth
 * for "what is on the main pane": `/c/<channelId>` for chat channels,
 * `/m/<moduleId>[/<subpath>]` for module views, `/` for the default view.
 *
 * Modules never touch the History API — they navigate through store actions,
 * which call `navigate()` here. `navigate()` only records history; applying
 * the route to state is the caller's job. The reverse direction (back/forward
 * buttons) flows through `onRouteChange` subscribers.
 */

export type Route =
  | { kind: 'home' }
  | { kind: 'channel'; channelId: string }
  | { kind: 'module'; moduleId: string; subpath: string }

export function parseRoute(pathname: string): Route {
  const parts = pathname.split('/').filter(Boolean)
  if (parts[0] === 'c' && parts[1]) {
    return { kind: 'channel', channelId: decodeURIComponent(parts[1]) }
  }
  if (parts[0] === 'm' && parts[1]) {
    return {
      kind: 'module',
      moduleId: decodeURIComponent(parts[1]),
      subpath: parts.slice(2).map(decodeURIComponent).join('/'),
    }
  }
  return { kind: 'home' }
}

export function routePath(route: Route): string {
  switch (route.kind) {
    case 'home':
      return '/'
    case 'channel':
      return `/c/${encodeURIComponent(route.channelId)}`
    case 'module': {
      const base = `/m/${encodeURIComponent(route.moduleId)}`
      if (!route.subpath) return base
      return `${base}/${route.subpath.split('/').map(encodeURIComponent).join('/')}`
    }
  }
}

export function currentRoute(): Route {
  return parseRoute(location.pathname)
}

/**
 * Record a route in history. `replace` is for state-driven corrections
 * (default channel after welcome, retired-channel fallback) so they don't
 * pollute the back stack; user navigation pushes.
 */
export function navigate(route: Route, opts?: { replace?: boolean }): void {
  const path = routePath(route)
  if (location.pathname === path) return
  history[opts?.replace ? 'replaceState' : 'pushState'](null, '', path)
}

type Listener = (route: Route) => void
const listeners = new Set<Listener>()

/** Subscribe to back/forward navigation. Returns an unsubscribe function. */
export function onRouteChange(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// Module scope is browser-only in the app; guarded so pure-function tests can
// import this file under the node test environment.
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    const route = currentRoute()
    for (const fn of listeners) fn(route)
  })
}
