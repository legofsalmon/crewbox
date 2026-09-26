import type { BoxSettingName, BoxSettings } from './api.ts'

/**
 * The Box settings form's values, one string per setting, and how they turn
 * into a save. Kept apart from the component so the rules can be tested.
 *
 * A field holds the setting's own text ("1", "Europe/Dublin", …), and the
 * empty string means "the default". The one exception is the module list,
 * where empty is a real answer (a chat-only box), so it is always saved as
 * an explicit list once somebody has touched it.
 */
export type BoxForm = Record<BoxSettingName, string>

export const DEFAULT_MODULES = 'schedule,patch,lighting,incident,video,network'

/** What a field shows: the saved value, else what the box started with, else the default. */
export function formFrom(data: BoxSettings): BoxForm {
  const value = (name: BoxSettingName): string => {
    const row = data.settings[name]
    return row?.saved ?? (row?.fromEnv ? row.boot : undefined) ?? ''
  }
  const modules = data.settings.CREWBOX_MODULES
  return {
    CREWBOX_MODULES: modules?.saved ?? modules?.boot ?? DEFAULT_MODULES,
    CREWBOX_TZ: value('CREWBOX_TZ'),
    CREWBOX_DMX_ARTNET_BASE: value('CREWBOX_DMX_ARTNET_BASE'),
    CREWBOX_WATCH: value('CREWBOX_WATCH'),
    CREWBOX_WATCH_IFACE: value('CREWBOX_WATCH_IFACE'),
    CREWBOX_VIDEO_IFACE: value('CREWBOX_VIDEO_IFACE'),
    CREWBOX_VIDEO_SNMP_COMMUNITY: value('CREWBOX_VIDEO_SNMP_COMMUNITY'),
    CREWBOX_UPDATE_CHECK: value('CREWBOX_UPDATE_CHECK'),
    CREWBOX_CAPTIVE: value('CREWBOX_CAPTIVE'),
    CREWBOX_CAPTIVE_PORT: value('CREWBOX_CAPTIVE_PORT'),
    SESSION_TTL_DAYS: value('SESSION_TTL_DAYS'),
    CREWBOX_BACKUP_HOURS: value('CREWBOX_BACKUP_HOURS'),
  }
}

/** Module ids ticked in a module list. */
export const moduleIds = (list: string): string[] =>
  list
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m && m !== 'chat')

/**
 * The fields that changed, as the box wants them: text for a value, null to
 * go back to the default. Settings the environment pins are never sent.
 */
export function changesFrom(
  data: BoxSettings,
  before: BoxForm,
  after: BoxForm
): Partial<Record<BoxSettingName, string | null>> {
  const out: Partial<Record<BoxSettingName, string | null>> = {}
  for (const name of Object.keys(after) as BoxSettingName[]) {
    if (data.settings[name]?.fromEnv) continue
    const was = before[name].trim()
    const now = after[name].trim()
    if (name === 'CREWBOX_MODULES') {
      if (moduleIds(was).join(',') !== moduleIds(now).join(',')) out[name] = now
      continue
    }
    if (was !== now) out[name] = now === '' ? null : now
  }
  return out
}
