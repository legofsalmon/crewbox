// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../store.ts'
import { goBack } from '../shell/back.ts'
import type { CameraPermission } from '../lib/server.ts'
import Composer from './Composer.tsx'

/**
 * Taking a photo for a message, from the attach button.
 *
 * The Android app's web view sends a plain file input to the system's file
 * picker, which has no camera, so the app offers one itself. Everywhere else
 * the phone's own picker already has a camera in it, and the attach button
 * stays exactly as it was.
 */

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

let root: Root
let host: HTMLElement
let opened: HTMLInputElement[]
const sendFile = vi.fn(async () => {})

function inApp(platform: 'android' | 'ios'): void {
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => platform, Plugins: {} }
}

function render(): void {
  act(() => root.render(<Composer channelId="general" placeholder="Message #general" />))
}

const attach = () => host.querySelector<HTMLButtonElement>('.attach-btn')!
const menu = () => document.querySelector<HTMLElement>('[role="menu"]')
const item = (name: RegExp) =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) =>
    name.test(el.textContent ?? '')
  )!
const tap = (el: HTMLElement) => {
  act(() => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    el.click()
  })
}
const key = (el: HTMLElement, name: string) =>
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
  })

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  document.body.innerHTML = ''
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  opened = []
  // A file input's click opens the phone's picker; here, it records which.
  vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
    this: HTMLInputElement
  ) {
    opened.push(this)
  })
  sendFile.mockClear()
  useStore.setState({ sendFile, uploading: false })
})

afterEach(() => {
  act(() => root.unmount())
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined
  vi.restoreAllMocks()
  delete window.Capacitor
})

describe('the attach button, where the phone already offers a camera', () => {
  it('opens the picker straight away in a browser', () => {
    render()
    tap(attach())
    expect(opened).toHaveLength(1)
    expect(opened[0]!.hasAttribute('capture')).toBe(false)
    expect(menu()).toBeNull()
    expect(attach().hasAttribute('aria-haspopup')).toBe(false)
  })

  it('opens the picker straight away in the iPhone app, whose picker has Take Photo', () => {
    inApp('ios')
    render()
    tap(attach())
    expect(opened).toHaveLength(1)
    expect(menu()).toBeNull()
  })
})

describe('the attach button in the Android app', () => {
  beforeEach(() => inApp('android'))

  it('offers the camera, or a photo or file from the phone', () => {
    render()
    tap(attach())
    expect(opened).toEqual([])
    expect(item(/Take a photo/)).toBeTruthy()
    expect(item(/Choose a photo or file/)).toBeTruthy()
    expect(attach().getAttribute('aria-haspopup')).toBe('menu')
    expect(attach().getAttribute('aria-expanded')).toBe('true')
    // Keyboard and screen reader users land in it.
    expect(document.activeElement).toBe(item(/Take a photo/))
  })

  it('opens the camera for "Take a photo"', () => {
    render()
    tap(attach())
    tap(item(/Take a photo/))
    expect(opened).toHaveLength(1)
    // The web view reads these two as "capture a photo": the camera, not the
    // file picker.
    expect(opened[0]!.getAttribute('accept')).toBe('image/*')
    expect(opened[0]!.getAttribute('capture')).toBe('environment')
    expect(menu()).toBeNull()
  })

  it('opens the ordinary picker for anything else', () => {
    render()
    tap(attach())
    tap(item(/Choose a photo or file/))
    expect(opened).toHaveLength(1)
    expect(opened[0]!.hasAttribute('capture')).toBe(false)
    expect(opened[0]!.hasAttribute('accept')).toBe(false)
    expect(menu()).toBeNull()
  })

  it('sends the photo the camera took', () => {
    render()
    tap(attach())
    tap(item(/Take a photo/))
    const camera = opened[0]!
    const photo = new File(['jpeg'], 'JPEG_20260924_101500_1.jpg', { type: 'image/jpeg' })
    Object.defineProperty(camera, 'files', { value: [photo], configurable: true })
    act(() => {
      camera.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(sendFile).toHaveBeenCalledWith('general', photo)
  })

  it('closes on Escape and gives the attach button its focus back', () => {
    render()
    tap(attach())
    key(item(/Take a photo/), 'Escape')
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(attach())
    expect(attach().getAttribute('aria-expanded')).toBe('false')
  })

  it('closes on a tap anywhere else', () => {
    render()
    tap(attach())
    tap(document.body)
    expect(menu()).toBeNull()
    expect(opened).toEqual([])
  })

  it('closes on a second tap of the attach button, rather than closing and reopening', () => {
    render()
    tap(attach())
    tap(attach())
    expect(menu()).toBeNull()
  })

  it('closes on the back button, before back goes anywhere', () => {
    const back = vi.spyOn(history, 'back').mockImplementation(() => {})
    render()
    tap(attach())
    act(() => void goBack(true))
    expect(menu()).toBeNull()
    expect(back).not.toHaveBeenCalled()
  })

  it('moves between its choices with the arrow keys', () => {
    render()
    tap(attach())
    key(menu()!, 'ArrowDown')
    expect(document.activeElement).toBe(item(/Choose a photo or file/))
    key(menu()!, 'ArrowDown')
    expect(document.activeElement).toBe(item(/Take a photo/))
    key(menu()!, 'ArrowUp')
    expect(document.activeElement).toBe(item(/Choose a photo or file/))
  })
})

describe('a camera the Android app is not allowed', () => {
  let camera: CameraPermission
  const checkPermissions = vi.fn(async () => ({ camera }))
  const openSettings = vi.fn(async () => {})

  beforeEach(() => {
    camera = 'denied'
    checkPermissions.mockClear()
    openSettings.mockClear()
    window.Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      Plugins: {
        CrewboxScanner: {
          scan: async () => ({ result: 'cancelled' }),
          openSettings,
          checkPermissions,
        },
      },
    }
  })

  const note = () => host.querySelector('.camera-note')
  const button = (name: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (el) => el.textContent === name || el.getAttribute('aria-label') === name
    )
  /** Take a photo, and the web view handing back nothing, as it does for a refused camera. */
  async function takePhotoAndGetNothing(): Promise<void> {
    tap(attach())
    tap(item(/Take a photo/))
    const input = opened.at(-1)!
    expect(input.getAttribute('capture')).toBe('environment')
    await act(async () => {
      input.dispatchEvent(new Event('cancel'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }

  it.each<CameraPermission>(['denied', 'prompt', 'prompt-with-rationale'])(
    'says so when Take a photo comes back with nothing and the camera is %s',
    async (state) => {
      camera = state
      render()
      await takePhotoAndGetNothing()
      expect(checkPermissions).toHaveBeenCalledTimes(1)
      expect(note()?.textContent).toContain('Crewbox isn’t allowed to use the camera')
      expect(note()?.textContent).toContain('choose a photo already on the phone')
      expect(note()?.getAttribute('role')).toBe('status')
      tap(button('Open Settings')!)
      expect(openSettings).toHaveBeenCalledTimes(1)
    }
  )

  it('says nothing when somebody backs out of the camera', async () => {
    camera = 'granted'
    render()
    await takePhotoAndGetNothing()
    expect(checkPermissions).toHaveBeenCalledTimes(1)
    expect(note()).toBeNull()
  })

  it('says nothing when there is nobody to ask', async () => {
    window.Capacitor!.Plugins = {}
    render()
    await takePhotoAndGetNothing()
    expect(note()).toBeNull()
  })

  it('says nothing when asking fails', async () => {
    checkPermissions.mockRejectedValueOnce(new Error('bridge gone'))
    render()
    await takePhotoAndGetNothing()
    expect(note()).toBeNull()
  })

  it('goes once the camera is allowed in Settings and the app is back', async () => {
    render()
    await takePhotoAndGetNothing()
    expect(note()).not.toBeNull()
    camera = 'granted'
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(note()).toBeNull()
  })

  it('stays when the app is back and the camera still is not allowed', async () => {
    render()
    await takePhotoAndGetNothing()
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(note()).not.toBeNull()
  })

  it('goes on ✕, on the next try, and when a photo comes through', async () => {
    render()
    await takePhotoAndGetNothing()
    tap(button('Dismiss')!)
    expect(note()).toBeNull()

    await takePhotoAndGetNothing()
    tap(attach())
    expect(note()).toBeNull()
    tap(attach())

    await takePhotoAndGetNothing()
    const input = opened.at(-1)!
    const photo = new File(['jpeg'], 'JPEG_20260924_171500_1.jpg', { type: 'image/jpeg' })
    Object.defineProperty(input, 'files', { value: [photo], configurable: true })
    act(() => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(note()).toBeNull()
  })
})
