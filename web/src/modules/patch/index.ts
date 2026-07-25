import type { CrewboxModule } from '../../shell/modules.ts'
import PatchSidebar from './PatchSidebar.tsx'
import PatchMain from './PatchMain.tsx'

/**
 * Patch Sheets — placeholder registration. The Live Patch port lands here in
 * Phase 3 (docs/UNIFICATION_PLAN.md); until then the module is hidden unless
 * the box enables it (CREWBOX_MODULES=patch), where it proves the module
 * seam end to end: config gating, sidebar section, /m/patch route.
 */
export const patchModule: CrewboxModule = {
  id: 'patch',
  title: 'Patch Sheets',
  SidebarSection: PatchSidebar,
  Main: PatchMain,
}
