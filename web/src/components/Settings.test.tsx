// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useStore } from '../store.ts'
import Settings from './Settings.tsx'

/**
 * Settings, which everyone opens from the cog: their own tabs, and the Admin
 * tab, which is always there and shows the password box until it is
 * unlocked. What unlocking does against a real box is in e2e/admin.spec.ts.
 */

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

let root: Root
let host: HTMLElement

function render(): void {
  act(() => root.render(<Settings />))
}
const tabs = () =>
  [...host.querySelectorAll('[role="tab"]')].map((tab) => ({
    name: tab.getAttribute('aria-label') ?? tab.textContent,
    selected: tab.getAttribute('aria-selected') === 'true',
  }))
const panel = () => host.querySelector('[role="tabpanel"]')!

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  useStore.setState({
    settingsOpen: true,
    settingsTab: 'general',
    adminToken: null,
    adminLockedReason: null,
    config: { ...useStore.getState().config, alerts: undefined },
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('the tabs', () => {
  it('are everyone’s, with Admin last and saying it is locked', () => {
    render()
    expect(tabs()).toEqual([
      { name: 'General', selected: true },
      { name: 'Feedback', selected: false },
      { name: 'Admin, locked', selected: false },
    ])
    expect(panel().querySelector('[role="switch"]')).not.toBeNull()
  })

  it('include Alerts only on a box that keeps them', () => {
    useStore.setState({
      config: { ...useStore.getState().config, alerts: 1 },
    })
    render()
    expect(tabs().map((tab) => tab.name)).toContain('Alerts')
  })

  it('fall back to General when the tab left open is not on this box', () => {
    useStore.setState({ settingsTab: 'alerts' })
    render()
    expect(tabs()[0]).toEqual({ name: 'General', selected: true })
  })

  it('move with the arrow keys, one Tab stop for the row', () => {
    render()
    const general = host.querySelector<HTMLElement>('#settings-tab-general')!
    act(() => {
      general.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    })
    expect(useStore.getState().settingsTab).toBe('admin')
    expect([...host.querySelectorAll('[role="tab"][tabindex="0"]')]).toHaveLength(1)
  })
})

describe('the Admin tab', () => {
  it('asks for the password while locked', () => {
    useStore.setState({ settingsTab: 'admin' })
    render()
    expect(panel().querySelector('#admin-password')).not.toBeNull()
  })

  it('is what ?admin and the admin link open, explaining nothing stale', () => {
    useStore.setState({ settingsOpen: false, settingsTab: 'general', adminLockedReason: 'old' })
    useStore.getState().openSettings('admin')
    const state = useStore.getState()
    expect([state.settingsOpen, state.settingsTab, state.adminLockedReason]).toEqual([
      true,
      'admin',
      null,
    ])
  })

  it('locks in place: Lock leaves Settings open on the password box', () => {
    useStore.setState({ settingsTab: 'admin', adminToken: 'unlocked' })
    useStore.getState().lockAdmin()
    const state = useStore.getState()
    expect([state.settingsOpen, state.settingsTab, state.adminToken]).toEqual([true, 'admin', null])
  })
})

describe('opening it', () => {
  it('reopens on the tab it was left on', () => {
    useStore.setState({ settingsOpen: false, settingsTab: 'feedback' })
    useStore.getState().openSettings()
    expect(useStore.getState().settingsTab).toBe('feedback')
  })
})
