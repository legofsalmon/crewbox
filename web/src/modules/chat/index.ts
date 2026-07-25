import type { CrewboxModule } from '../../shell/modules.ts'
import type { AppState } from '../../store.ts'
import ChatSidebar from './ChatSidebar.tsx'

/**
 * Chat — the core module. The default view: it owns the /c/<channelId>
 * routes and the main pane whenever no other module is active, so it has no
 * `Main` here.
 */
export const chatModule: CrewboxModule = {
  id: 'chat',
  title: 'Chat',
  SidebarSection: ChatSidebar,
  unreadCount(state: AppState): number {
    let total = 0
    for (const channel of Object.values(state.channels)) {
      if (channel.retired) continue
      total += Math.max(0, channel.lastSeq - (state.readState[channel.id] ?? 0))
    }
    return total
  },
}
