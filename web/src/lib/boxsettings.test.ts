import { describe, expect, it } from 'vitest'
import type { BoxSettings } from './api.ts'
import { changesFrom, DEFAULT_MODULES, formFrom } from './boxsettings.ts'

const data = (settings: BoxSettings['settings'] = {}): BoxSettings => ({
  settings,
  restartNeeded: false,
  modules: ['schedule', 'patch', 'lighting', 'incident', 'video', 'network'],
  adapters: [],
})

describe('the Box settings form', () => {
  it('starts from saved values, then what the environment pins, then the default', () => {
    const form = formFrom(
      data({
        CREWBOX_TZ: { saved: 'Europe/Dublin', fromEnv: false, boot: 'UTC' },
        CREWBOX_WATCH: { fromEnv: true, boot: '1' },
        // Booted with a value that has since been cleared: the field shows the default.
        SESSION_TTL_DAYS: { fromEnv: false, boot: '30' },
      })
    )
    expect(form.CREWBOX_TZ).toBe('Europe/Dublin')
    expect(form.CREWBOX_WATCH).toBe('1')
    expect(form.SESSION_TTL_DAYS).toBe('')
    expect(form.CREWBOX_MODULES).toBe(DEFAULT_MODULES)
  })

  it('sends only what changed, and a cleared field as null', () => {
    const d = data({ CREWBOX_TZ: { saved: 'Europe/Dublin', fromEnv: false } })
    const before = formFrom(d)
    const after = { ...before, CREWBOX_TZ: '', CREWBOX_CAPTIVE: '0' }
    expect(changesFrom(d, before, after)).toEqual({ CREWBOX_TZ: null, CREWBOX_CAPTIVE: '0' })
  })

  it('saves an empty module list as chat-only rather than the default', () => {
    const d = data()
    const before = formFrom(d)
    expect(changesFrom(d, before, { ...before, CREWBOX_MODULES: '' })).toEqual({
      CREWBOX_MODULES: '',
    })
  })

  it('never sends a setting the environment pins', () => {
    const d = data({ CREWBOX_TZ: { fromEnv: true, boot: 'UTC' } })
    const before = formFrom(d)
    expect(changesFrom(d, before, { ...before, CREWBOX_TZ: 'Europe/Paris' })).toEqual({})
  })
})
