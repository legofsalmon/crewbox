// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ErrorBoundary from './ErrorBoundary.tsx'
import type { ClientCrash, Outcome } from '../lib/reports.ts'

/**
 * The error screen: a throw becomes a way back instead of a blank phone,
 * "Try again" keeps everything outside the boundary, and a report goes only
 * when the person presses Send.
 */

// React logs every caught render error; the test is that it was caught.
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let root: Root | null = null
let host: HTMLElement
afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  vi.restoreAllMocks()
})

function render(node: React.ReactNode) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(node))
}

const click = (el: Element | null | undefined) =>
  act(() => {
    ;(el as HTMLElement).click()
  })

const button = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === label)

let explode = true
function Fragile() {
  if (explode) throw new TypeError('cannot read properties of undefined')
  return <p>working</p>
}

describe('the error screen', () => {
  it('replaces a crashed pane with a way back, and sends nothing on its own', () => {
    explode = true
    const send = vi.fn<(c: ClientCrash) => Promise<Outcome>>()
    render(
      <ErrorBoundary version="1.0.0" send={send} header={<button>menu</button>}>
        <Fragile />
      </ErrorBoundary>
    )
    expect(host.textContent).toContain('Something went wrong on this screen')
    expect(host.textContent).toContain('Your messages are safe')
    // The module pane's drawer button is kept, so a phone is not stranded.
    expect(button('menu')).toBeDefined()
    expect(send).not.toHaveBeenCalled()
  })

  it('tries again without touching what is outside it', () => {
    explode = true
    function Outside() {
      const [draft, setDraft] = useState('half a message')
      return (
        <>
          <input value={draft} onChange={(e) => setDraft(e.target.value)} />
          <ErrorBoundary version="1.0.0" send={vi.fn()}>
            <Fragile />
          </ErrorBoundary>
        </>
      )
    }
    render(<Outside />)
    expect(host.querySelector('input')?.value).toBe('half a message')
    explode = false
    click(button('Try again'))
    expect(host.textContent).toContain('working')
    expect(host.querySelector('input')?.value).toBe('half a message')
  })

  it('clears itself when the person moves somewhere else', () => {
    explode = true
    const send = vi.fn()
    render(
      <ErrorBoundary version="1.0.0" send={send} resetKey="chat:a">
        <Fragile />
      </ErrorBoundary>
    )
    explode = false
    act(() =>
      root!.render(
        <ErrorBoundary version="1.0.0" send={send} resetKey="patch:">
          <Fragile />
        </ErrorBoundary>
      )
    )
    expect(host.textContent).toContain('working')
  })

  it('sends the report, with the note, only when Send is pressed', async () => {
    explode = true
    const send = vi.fn<(c: ClientCrash) => Promise<Outcome>>(() => Promise.resolve('sent'))
    render(
      <ErrorBoundary version="1.0.0+abc" send={send}>
        <Fragile />
      </ErrorBoundary>
    )
    const textarea = host.querySelector('textarea')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea, 'Opening the patch sheet')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      button('Send report')!.click()
    })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toMatchObject({
      summary: 'TypeError: cannot read properties of undefined',
      version: '1.0.0+abc',
      note: 'Opening the patch sheet',
    })
    expect(host.textContent).toContain('Sent to the box')
  })

  it('says so when the report is kept for later', async () => {
    explode = true
    render(
      <ErrorBoundary version="1.0.0" send={() => Promise.resolve('saved')}>
        <Fragile />
      </ErrorBoundary>
    )
    await act(async () => {
      button('Send report')!.click()
    })
    expect(host.textContent).toContain('It goes when the box is reachable')
  })
})
