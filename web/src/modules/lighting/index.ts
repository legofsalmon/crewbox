import type { CrewboxModule } from '../../shell/modules.ts'
import LightingSidebar from './LightingSidebar.tsx'
import LightingMain from './LightingMain.tsx'

/**
 * Lighting — fixture patch, rigging positions, and a schematic plot. The
 * second shared-doc module, and the one that proved the doc-store extraction
 * (docs/MODULES.md). Visible only where the box enables it:
 * CREWBOX_MODULES=lighting.
 */
export const lightingModule: CrewboxModule = {
  id: 'lighting',
  title: 'Lighting',
  SidebarSection: LightingSidebar,
  Main: LightingMain,
}
