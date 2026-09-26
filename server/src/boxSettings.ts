/**
 * Box settings an admin chooses in the panel instead of the environment.
 *
 * Each one used to be reachable only as an environment variable, which on a
 * Mac or Windows box started from the menu bar or the tray means nowhere at
 * all: there is no terminal and no service file. They are saved in the
 * settings table in the *same text form the variable takes*, so config.ts
 * parses a saved value and an environment one with the same code, and a
 * value that works in one works in the other.
 *
 * The environment still wins where it is set. That keeps the terminal the
 * way back from a bad save, the same rule the network settings follow, and
 * the panel shows such a setting as pinned rather than offering a field
 * whose saves would be ignored.
 *
 * All of them are read once at startup, so a change applies on the next
 * start and the panel says so.
 */

import type { Store } from './store.ts'

/** Module ids a box can turn on beyond chat, which is always on. */
export const OPTIONAL_MODULES = [
  'schedule',
  'patch',
  'lighting',
  'incident',
  'video',
  'network',
] as const

const isIpv4 = (v: string): boolean =>
  /^(\d{1,3}\.){3}\d{1,3}$/.test(v) && v.split('.').every((octet) => Number(octet) <= 255)

const oneOf =
  (allowed: readonly string[], message: string) =>
  (v: string): string | null =>
    allowed.includes(v) ? null : message

const ipv4OrBlank = (v: string): string | null =>
  v === '' || isIpv4(v) ? null : 'That needs to be an IPv4 address, or left blank.'

const wholeNumber =
  (min: number, max: number, message: string) =>
  (v: string): string | null => {
    if (!/^\d+$/.test(v)) return message
    const n = Number(v)
    return n >= min && n <= max ? null : message
  }

/** Whether the runtime knows `zone` as an IANA timezone name. */
export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/**
 * Every setting the panel can save, by the environment variable it stands in
 * for. `check` returns why a value is refused, or null. A value is always a
 * string in the variable's own syntax; clearing one is a separate act (see
 * clearBoxSetting), because for some of them the empty string means
 * something — CREWBOX_MODULES='' is a chat-only box.
 */
export const BOX_SETTINGS = {
  CREWBOX_MODULES: (v: string): string | null => {
    const ids = v
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean)
    const unknown = ids.filter(
      (m) => m !== 'chat' && !(OPTIONAL_MODULES as readonly string[]).includes(m)
    )
    return unknown.length ? `No module called ${unknown.join(', ')}.` : null
  },
  CREWBOX_TZ: (v: string): string | null =>
    v === '' || isTimeZone(v) ? null : 'That is not a timezone name, like Europe/Dublin.',
  CREWBOX_DMX_ARTNET_BASE: oneOf(['0', '1'], 'Art-Net universe 0 is plot universe 0 or 1.'),
  CREWBOX_WATCH: oneOf(['0', '1'], 'Media network watching is on or off.'),
  CREWBOX_WATCH_IFACE: ipv4OrBlank,
  CREWBOX_VIDEO_IFACE: ipv4OrBlank,
  CREWBOX_VIDEO_SNMP_COMMUNITY: (v: string): string | null =>
    /^[\x21-\x7e]{0,32}$/.test(v) ? null : 'An SNMP community is up to 32 characters, no spaces.',
  CREWBOX_UPDATE_CHECK: oneOf(['0', '1'], 'Internet use is on or off.'),
  CREWBOX_CAPTIVE: oneOf(['0', '1'], 'Answering phone checks is on or off.'),
  CREWBOX_CAPTIVE_PORT: wholeNumber(1, 65535, 'A port is a number from 1 to 65535.'),
  SESSION_TTL_DAYS: wholeNumber(1, 3650, 'Sign-ins last from 1 to 3650 days.'),
  CREWBOX_BACKUP_HOURS: wholeNumber(0, 720, 'Backups run every 0 (never) to 720 hours.'),
} satisfies Record<string, (v: string) => string | null>

export type BoxSettingName = keyof typeof BOX_SETTINGS

export const BOX_SETTING_NAMES = Object.keys(BOX_SETTINGS) as BoxSettingName[]

export const isBoxSetting = (name: string): name is BoxSettingName =>
  Object.prototype.hasOwnProperty.call(BOX_SETTINGS, name)

/**
 * Where a saved value lives in the settings table. Named after the variable
 * so a box's database says plainly what it overrides. Never rename one: a
 * box already in the field would silently lose the setting.
 */
export const boxSettingKey = (name: BoxSettingName): string => `env:${name}`

export const savedBoxSetting = (store: Store, name: BoxSettingName): string | undefined =>
  store.getSetting(boxSettingKey(name))

export const clearBoxSetting = (store: Store, name: BoxSettingName): void =>
  store.deleteSetting(boxSettingKey(name))

/**
 * How startup reads a variable: the environment first, then what the panel
 * saved. Anything that is not a box setting comes from the environment alone.
 */
export const boxLookup =
  (store: Store, env: NodeJS.ProcessEnv = process.env) =>
  (name: string): string | undefined =>
    env[name] ?? (isBoxSetting(name) ? savedBoxSetting(store, name) : undefined)

/** One row of the panel's Box settings section. */
export interface BoxSettingState {
  /** What the panel saved, or undefined when it never has (the default applies). */
  saved?: string
  /** Set in the environment, so the panel cannot change it. */
  fromEnv: boolean
  /** What this process started with, when it came from somewhere. */
  boot?: string
}
