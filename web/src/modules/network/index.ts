import type { CrewboxModule } from '../../shell/modules.ts'
import NetworkSidebar from './NetworkSidebar.tsx'
import NetworkMain from './NetworkMain.tsx'

/**
 * Network — the A/V network audit: live grades for the crew, lighting and
 * media networks, with the history to back them and (via the admin panel
 * inside the pane) a deep probe. Visible to the whole crew wherever the box
 * enables it; on by default.
 */
export const networkModule: CrewboxModule = {
  id: 'network',
  title: 'Network',
  SidebarSection: NetworkSidebar,
  Main: NetworkMain,
}
