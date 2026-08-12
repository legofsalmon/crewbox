import type { CrewboxModule } from '../../shell/modules.ts'
import VideoSidebar from './VideoSidebar.tsx'
import VideoMain from './VideoMain.tsx'

/**
 * Video — watching the LED walls, and never driving them.
 *
 * The whole crew can read the pane; only an admin can change what the box
 * contacts, and only with a second confirmation each time something would go
 * on the video network. On by default, which is safe precisely because the
 * resting state is silence: a box with this module enabled and nothing armed
 * contacts nothing at all.
 *
 * `moduleId` is 'video' rather than 'led' because LED is the first section
 * here, not the last one — and the id reaches storage on real phones, so it
 * is not a thing that can be renamed later (docs/MODULES.md).
 */
export const videoModule: CrewboxModule = {
  id: 'video',
  title: 'Video',
  SidebarSection: VideoSidebar,
  Main: VideoMain,
}
