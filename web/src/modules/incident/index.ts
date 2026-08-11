import type { CrewboxModule } from '../../shell/modules.ts'
import IncidentSidebar from './IncidentSidebar.tsx'
import IncidentMain from './ui/IncidentMain.tsx'

/**
 * Show log — what happened, when, and who wrote it down.
 *
 * The one module backed by the box's ordered log rather than a shared
 * document, because a record of a night is not a document people edit: it is
 * appended to, and corrected underneath. See shared/src/incident.ts and
 * docs/MODULES.md on the two sync primitives.
 */
export const incidentModule: CrewboxModule = {
  id: 'incident',
  title: 'Show log',
  SidebarSection: IncidentSidebar,
  Main: IncidentMain,
}
