// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, User } from '@crewbox/shared'
import { useStore } from '../../store.ts'
import ChatSidebar from './ChatSidebar.tsx'

/**
 * Direct messages list the people who are online. Everyone else who has ever
 * joined waits behind one link, unless they have written to you or their
 * conversation is the one open.
 */

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

let root: Root
let host: HTMLElement

const user = (id: string, name: string): User => ({ id, name, role: 'member', createdAt: 0 })
const dm = (other: string, lastSeq: number): Channel => ({
  id: `dm-${other}`,
  name: '',
  kind: 'dm',
  topic: '',
  lastSeq,
  memberIds: ['me', other],
  createdAt: 0,
})

function render(): void {
  act(() => root.render(<ChatSidebar />))
}

const names = () =>
  [...host.querySelectorAll<HTMLElement>('button[aria-label^="Message "]')].map(
    (b) => b.querySelector('.row-name')!.textContent
  )
const more = () => host.querySelector<HTMLButtonElement>('.row-more')

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  useStore.setState({
    me: user('me', 'Me'),
    users: {
      me: user('me', 'Me'),
      alex: user('alex', 'Alex'),
      jo: user('jo', 'Jo'),
      sam: user('sam', 'Sam'),
      kit: user('kit', 'Kit'),
    },
    channels: { 'dm-sam': dm('sam', 3), 'dm-kit': dm('kit', 2) },
    online: { alex: true },
    remoteUsers: {},
    readState: { 'dm-sam': 1, 'dm-kit': 2 },
    mentionSeqs: {},
    activeChannelId: 'general',
    activeModuleId: null,
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('direct messages', () => {
  it('lists online people and anyone with unread, and hides the rest behind a link', () => {
    render()
    expect(names()).toEqual(['Alex', 'Sam'])
    expect(more()?.textContent).toBe('Show 2 offline')
    expect(more()?.getAttribute('aria-expanded')).toBe('false')
  })

  it('opens and closes the offline people with one click each', () => {
    render()
    act(() => more()!.click())
    expect(names()).toEqual(['Alex', 'Sam', 'Jo', 'Kit'])
    expect(more()?.textContent).toBe('Hide offline')
    act(() => more()!.click())
    expect(names()).toEqual(['Alex', 'Sam'])
  })

  it('keeps the open conversation in view after its person goes offline', () => {
    useStore.setState({ activeChannelId: 'dm-kit' })
    render()
    expect(names()).toEqual(['Alex', 'Kit', 'Sam'])
    expect(more()?.textContent).toBe('Show 1 offline')
  })

  it('says no one is online, and offers no link when there is nobody to hide', () => {
    useStore.setState({ online: {}, readState: { 'dm-sam': 3, 'dm-kit': 2 } })
    render()
    expect(names()).toEqual([])
    expect(host.textContent).toContain('No one else is online')
    expect(more()?.textContent).toBe('Show 4 offline')

    act(() => useStore.setState({ online: { alex: true, jo: true, sam: true, kit: true } }))
    expect(more()).toBeNull()
  })
})
