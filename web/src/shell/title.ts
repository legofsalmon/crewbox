import { useStore } from '../store.ts'
import { allModules } from './registry.ts'
import { enabledModules } from './modules.ts'
import { displayName } from '../lib/settings.ts'

/**
 * Tab-title service: aggregates every enabled module's unread count into the
 * document title so a glance at the phone/laptop shows it. The shell owns
 * document.title — modules only contribute a number.
 *
 * Imported for side effect from main.tsx (not store.ts, which modules import
 * — this file closes the module→store→registry cycle at the top instead).
 */
useStore.subscribe((state) => {
  let total = 0
  for (const module of enabledModules(allModules, state.config.modules)) {
    total += module.unreadCount?.(state) ?? 0
  }
  const name = displayName(state.config.eventName)
  const title = total > 0 ? `(${total}) ${name}` : name
  if (document.title !== title) document.title = title
})
