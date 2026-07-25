import type { ComponentType } from 'react'
import type { AppState } from '../store.ts'

/**
 * The client-side module contract. A module owns a sidebar section and
 * (optionally) the main pane for its /m/<id> routes; the shell owns routing,
 * identity, connection state, the service worker, keyboard registry, toasts,
 * and the tab title.
 *
 * Chat is itself a module — special only in being the default view (it owns
 * the /c/<channelId> routes rather than /m/chat).
 */
export interface CrewboxModule {
  id: string
  title: string
  /** Sidebar section (header + rows) rendered inside the shell nav. */
  SidebarSection: ComponentType
  /** Main-pane view for /m/<id> routes; chat omits it (owns /c/*). */
  Main?: ComponentType<{ subpath: string }>
  /** Contribution to the tab-title unread total. */
  unreadCount?: (state: AppState) => number
}

/** Modules the box enables (config.modules), in registry order. */
export function enabledModules(all: CrewboxModule[], enabledIds: string[]): CrewboxModule[] {
  return all.filter((m) => enabledIds.includes(m.id))
}
