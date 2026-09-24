// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VideoIntent } from '@crewbox/shared'
import { useStore } from '../store.ts'
import ConnectionHelp from '../components/ConnectionHelp.tsx'
import ConfirmTransmit from '../modules/video/ui/ConfirmTransmit.tsx'
import { goBack, installBackButton, topmostDialog } from './back.ts'

/**
 * Android's back button in the app.
 *
 * With no handler, back went to the system and put the whole app away, so on
 * a phone there was no way to close a photo, search or a panel except the ✕.
 * The rule these pin down: back closes what is open before it leaves
 * anything, and it leaves the app running rather than closing it.
 */

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

const dialog = (attrs: Record<string, string> = {}, into: HTMLElement = document.body) => {
  const el = document.createElement('div')
  el.setAttribute('role', 'dialog')
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  into.append(el)
  return el
}

/** Every Escape that reaches the window, and where it was aimed. */
const escapes = () => {
  const seen: EventTarget[] = []
  const listener = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && e.target) seen.push(e.target)
  }
  window.addEventListener('keydown', listener)
  return { seen, stop: () => window.removeEventListener('keydown', listener) }
}

beforeEach(() => {
  document.body.innerHTML = ''
  useStore.setState({ sidebarOpen: false })
})

afterEach(() => {
  vi.restoreAllMocks()
  delete window.Capacitor
})

describe('which dialog a back press is for', () => {
  it('is the last open one, which is the one on top', () => {
    // A confirmation inside a panel comes after the panel in the document.
    const panel = dialog({ 'aria-label': 'Admin panel' })
    const confirm = dialog({ 'aria-label': 'Install and restart?' }, panel)
    expect(topmostDialog()).toBe(confirm)
  })

  it('is not one that is mounted but hidden, which would take every press', () => {
    const shown = dialog()
    dialog({ style: 'display: none' })
    expect(topmostDialog()).toBe(shown)
  })

  it('is none at all when nothing is open', () => {
    expect(topmostDialog()).toBeNull()
  })
})

describe('a back press', () => {
  it('sends the dialog on top an Escape, and nothing else happens', () => {
    const back = vi.spyOn(history, 'back')
    useStore.setState({ sidebarOpen: true })
    dialog()
    const top = dialog()
    const { seen, stop } = escapes()

    expect(goBack(true)).toBe('dialog')
    stop()

    expect(seen).toEqual([top])
    // The drawer and the history underneath wait for their own presses.
    expect(useStore.getState().sidebarOpen).toBe(true)
    expect(back).not.toHaveBeenCalled()
  })

  it('keeps an edit in progress, the way tapping outside the field would', () => {
    // A draft field reverts on Escape and saves on blur. On a phone back
    // means "done here", so the field is left before the dialog hears it.
    const top = dialog()
    const field = document.createElement('input')
    top.append(field)
    field.focus()
    const order: string[] = []
    field.addEventListener('blur', () => order.push('blur'))
    field.addEventListener('keydown', () => order.push('field heard Escape'))
    top.addEventListener('keydown', () => order.push('dialog heard Escape'))

    goBack(false)

    expect(order).toEqual(['blur', 'dialog heard Escape'])
    expect(document.activeElement).not.toBe(field)
  })

  it('stays with a dialog that ignores it, rather than leaving the screen under it', () => {
    // The account deletion ignores Escape while it is deleting. Back must
    // not then fall through to the screen underneath an open dialog.
    const back = vi.spyOn(history, 'back')
    dialog()
    expect(goBack(true)).toBe('dialog')
    expect(back).not.toHaveBeenCalled()
  })

  it('closes the drawer when no dialog is open', () => {
    const back = vi.spyOn(history, 'back')
    useStore.setState({ sidebarOpen: true })
    expect(goBack(true)).toBe('drawer')
    expect(useStore.getState().sidebarOpen).toBe(false)
    expect(back).not.toHaveBeenCalled()
  })

  it('goes back through the app’s own history when nothing is open', () => {
    const back = vi.spyOn(history, 'back').mockImplementation(() => {})
    expect(goBack(true)).toBe('history')
    expect(back).toHaveBeenCalledOnce()
  })

  it('says the app should step aside when there is nothing left to go back to', () => {
    const back = vi.spyOn(history, 'back')
    expect(goBack(false)).toBe('background')
    expect(back).not.toHaveBeenCalled()
  })
})

describe('in the native app', () => {
  const nativeApp = () => {
    const listeners: Record<string, (event: { canGoBack: boolean }) => void> = {}
    const app = {
      addListener: vi.fn((event: string, listener: (event: { canGoBack: boolean }) => void) => {
        listeners[event] = listener
        return { remove: async () => {} }
      }),
      minimizeApp: vi.fn(async () => {}),
    }
    window.Capacitor = { isNativePlatform: () => true, Plugins: { App: app } }
    return { app, press: (canGoBack: boolean) => listeners.backButton?.({ canGoBack }) }
  }

  it('goes to the background at the end, rather than closing', () => {
    // Closing would end a voice call and throw away the page, for a press
    // that usually means "not now". The home button does the same.
    const { app, press } = nativeApp()
    installBackButton()
    expect(app.addListener).toHaveBeenCalledWith('backButton', expect.any(Function))

    press(false)
    expect(app.minimizeApp).toHaveBeenCalledOnce()
  })

  it('stays in the app while there is something to close', () => {
    const { app, press } = nativeApp()
    installBackButton()
    dialog()
    press(false)
    useStore.setState({ sidebarOpen: true })
    document.body.innerHTML = ''
    press(false)
    expect(app.minimizeApp).not.toHaveBeenCalled()
  })

  it('leaves the browser’s own back button alone', () => {
    // In a browser the page has no App plugin, and back is the browser's.
    expect(() => installBackButton()).not.toThrow()
  })
})

describe('real dialogs', () => {
  let root: Root
  let host: HTMLElement

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    globalThis.IS_REACT_ACT_ENVIRONMENT = undefined
  })

  it('close through their own Escape handler', () => {
    // The shell's panels close on Escape from the backdrop. The press has to
    // reach React's handler, not just the DOM, for back to close them.
    const onClose = vi.fn()
    act(() => root.render(<ConnectionHelp onClose={onClose} />))
    act(() => void goBack(false))
    expect(onClose).toHaveBeenCalledOnce()
  })

  const intent: VideoIntent = {
    token: 'intent-token',
    action: 'scan',
    willSend: ['One discovery broadcast to 192.168.10.255 on port 3800'],
    target: '192.168.10.255',
    expiresAt: Date.now() + 60_000,
  }

  it('answer "Cancel" to a confirmation, never the choice that sends', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    act(() =>
      root.render(
        <ConfirmTransmit
          intent={intent}
          busy={false}
          error=""
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      )
    )
    act(() => void goBack(false))
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('leave a confirmation up once it is sending, like its Cancel button', () => {
    const onCancel = vi.fn()
    act(() =>
      root.render(
        <ConfirmTransmit
          intent={intent}
          busy={true}
          error=""
          onConfirm={() => {}}
          onCancel={onCancel}
        />
      )
    )
    act(() => void goBack(false))
    expect(onCancel).not.toHaveBeenCalled()
  })
})
