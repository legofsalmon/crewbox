import { chatModule } from '../modules/chat/index.ts'
import { patchModule } from '../modules/patch/index.ts'
import type { CrewboxModule } from './modules.ts'

/**
 * All modules this build knows about, in sidebar order. Which of them a crew
 * actually sees is the box's call: config.modules (from the welcome payload)
 * filters this list via enabledModules().
 */
export const allModules: CrewboxModule[] = [chatModule, patchModule]
