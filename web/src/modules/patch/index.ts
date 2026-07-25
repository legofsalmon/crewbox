import type { CrewboxModule } from '../../shell/modules.ts'
import PatchSidebar from './PatchSidebar.tsx'
import PatchMain from './PatchMain.tsx'

/**
 * Patch Sheets — the ported Live Patch app, and the reference implementation
 * of a shared-doc module (docs/MODULES.md). Visible only where the box
 * enables it: CREWBOX_MODULES=patch, which also gates the docs relay.
 */
export const patchModule: CrewboxModule = {
  id: 'patch',
  title: 'Patch Sheets',
  SidebarSection: PatchSidebar,
  Main: PatchMain,
}
