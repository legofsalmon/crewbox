import type { CrewboxModule } from '../../shell/modules.ts'
import ScheduleSidebar from './ScheduleSidebar.tsx'
import ScheduleMain from './ui/ScheduleMain.tsx'

/**
 * Schedule — the running order, for every department rather than for audio.
 *
 * The only module that owns no documents. A festival patch sheet is already
 * one stage's day, complete with set times, and this reads them: nobody
 * types the running order twice, and a set time corrected on the audio desk
 * moves the countdown on every phone. See model/agenda.ts.
 */
export const scheduleModule: CrewboxModule = {
  id: 'schedule',
  title: 'Running order',
  SidebarSection: ScheduleSidebar,
  Main: ScheduleMain,
}
