import { chatModule } from '../modules/chat/index.ts'
import { patchModule } from '../modules/patch/index.ts'
import { scheduleModule } from '../modules/schedule/index.ts'
import { lightingModule } from '../modules/lighting/index.ts'
import { incidentModule } from '../modules/incident/index.ts'
import { networkModule } from '../modules/network/index.ts'
import type { CrewboxModule } from './modules.ts'

/**
 * All modules this build knows about, in sidebar order. Which of them a crew
 * actually sees is the box's call: config.modules (from the welcome payload)
 * filters this list via enabledModules().
 */
export const allModules: CrewboxModule[] = [
  chatModule,
  scheduleModule,
  patchModule,
  lightingModule,
  incidentModule,
  networkModule,
]
