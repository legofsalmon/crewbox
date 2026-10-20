import type { CrewboxModule } from '../../shell/modules.ts'
import CuesSidebar from './CuesSidebar.tsx'
import CuesMain from './ui/CuesMain.tsx'

/**
 * Cue lights: a silent standby and GO, to a person, for when the stage is
 * too loud to talk (docs/CUES.md).
 *
 * Owns no documents and no log: a cue is live state the box holds
 * (server/src/cues.ts), so the module is only its screen. The operator's
 * lamp is the shell's (components/CueLight.tsx), because it has to light up
 * over whatever view they are in, with this module on or not.
 */
export const cuesModule: CrewboxModule = {
  id: 'cues',
  title: 'Cue lights',
  SidebarSection: CuesSidebar,
  Main: CuesMain,
}
