// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../store.ts'
import {
  acceptEvent,
  forgetEventRecord,
  knownEvent,
  knownEvents,
  openEvent,
  rememberEvent,
  type KnownEvent,
} from './eventScope.ts'
import {
  claimsOf,
  RECHECK_MS,
  resetFollowForTests,
  useFollowBoxes,
  weigh,
  type Check,
  type Claim,
} from './follow.ts'
import { proveBox } from './identity.ts'
import type { FoundService } from './server.ts'

/**
 * Following an event this phone holds to a box found at a new address.
 *
 * An announcement says where to ask and nothing more: anything on the Wi-Fi
 * can announce an event's ID. So the box there is asked to prove it with the
 * key kept for the event, and the event goes only to the one box that does,
 * and only on a proof that is fresh.
 */

vi.mock('./identity.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./identity.ts')>()),
  proveBox: vi.fn(),
}))

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

const KEY = 'A'.repeat(87)
const friday: KnownEvent = {
  id: 'friday',
  name: 'Harbour Fest',
  origin: 'http://10.0.0.2:8080',
  seenAt: 1,
  key: KEY,
}
const saturday: KnownEvent = {
  id: 'saturday',
  name: 'Harbour Tour',
  origin: 'http://10.0.0.3:8080',
  seenAt: 2,
  key: 'B'.repeat(87),
}

/** A box announcing `id` at `address`, port 8080. */
const at = (address: string, id: string, fields: Partial<FoundService> = {}): FoundService => ({
  name: `Box at ${address}`,
  addresses: [address],
  port: 8080,
  txt: { txtvers: '1', id, name: 'Harbour Fest', setup: '1' },
  ...fields,
})

const A = 'http://10.0.0.9:8080'
const B = 'http://10.0.0.7:8080'

describe('what is worth asking about', () => {
  it('is an event held with a key, announced at another address', () => {
    expect(claimsOf([at('10.0.0.9', 'friday')], [friday])).toEqual([{ event: friday, origin: A }])
  })

  it('is not its own address, nor an event not held, nor one held with no key', () => {
    const { key: _, ...keyless } = friday
    expect(claimsOf([at('10.0.0.2', 'friday')], [friday])).toEqual([])
    expect(claimsOf([at('10.0.0.9', 'sunday')], [friday])).toEqual([])
    expect(claimsOf([at('10.0.0.9', 'friday')], [keyless])).toEqual([])
  })

  it('is each address once, and nothing without an address to ask', () => {
    const twice = [at('10.0.0.9', 'friday'), at('10.0.0.9', 'friday', { name: 'Again' })]
    expect(claimsOf(twice, [friday])).toHaveLength(1)
    expect(claimsOf([at('fe80::1', 'friday')], [friday])).toEqual([])
  })
})

describe('what is done about it', () => {
  const now = 10_000_000
  const claim = (origin: string, event: KnownEvent = friday): Claim => ({ event, origin })
  const answers =
    (found: Record<string, Check>) =>
    (asked: Claim): Check | undefined =>
      found[`${asked.event.id} ${asked.origin}`]
  const answer = (result: Check['result'], ago = 1000): Check =>
    result === 'checking' ? { result } : { result, at: now - ago }

  it('asks a box never asked, and follows nothing yet', () => {
    const plan = weigh([claim(A)], now, answers({}))
    expect(plan.ask).toEqual([claim(A)])
    expect(plan.follow.size).toBe(0)
  })

  it('follows the one address that has just proven it', () => {
    const plan = weigh([claim(A)], now, answers({ [`friday ${A}`]: answer('proven') }))
    expect(plan.ask).toEqual([])
    expect([...plan.follow]).toEqual([['friday', A]])
  })

  it('follows it past a box that failed, or could not be checked', () => {
    for (const other of ['refused', 'unchecked'] as const) {
      const plan = weigh(
        [claim(A), claim(B)],
        now,
        answers({ [`friday ${A}`]: answer('proven'), [`friday ${B}`]: answer(other) })
      )
      expect([...plan.follow]).toEqual([['friday', A]])
    }
  })

  it('waits while another box for the event is still being asked', () => {
    const plan = weigh(
      [claim(A), claim(B)],
      now,
      answers({ [`friday ${A}`]: answer('proven'), [`friday ${B}`]: answer('checking') })
    )
    expect(plan.ask).toEqual([])
    expect(plan.follow.size).toBe(0)
  })

  it('follows neither of two boxes that both prove it', () => {
    // A box and a spare restored from its backup: which the crew are on is
    // not for the phone to guess.
    const plan = weigh(
      [claim(A), claim(B)],
      now,
      answers({ [`friday ${A}`]: answer('proven'), [`friday ${B}`]: answer('proven') })
    )
    expect(plan.follow.size).toBe(0)
  })

  it('asks again a minute on, and takes no proof that old as a fresh one', () => {
    const plan = weigh(
      [claim(A), claim(B)],
      now,
      answers({
        [`friday ${A}`]: answer('refused', RECHECK_MS),
        [`friday ${B}`]: answer('proven', RECHECK_MS),
      })
    )
    expect(plan.ask).toEqual([claim(A), claim(B)])
    expect(plan.follow.size).toBe(0)
    const sooner = weigh([claim(A)], now, answers({ [`friday ${A}`]: answer('refused', 59_999) }))
    expect(sooner.ask).toEqual([])
  })

  it('keeps each event to its own boxes', () => {
    const plan = weigh(
      [claim(A), claim(B, saturday)],
      now,
      answers({ [`friday ${A}`]: answer('proven'), [`saturday ${B}`]: answer('proven') })
    )
    expect(plan.follow).toEqual(
      new Map([
        ['friday', A],
        ['saturday', B],
      ])
    )
  })
})

// ---------------------------------------------------------------------------

function Following(props: { services: FoundService[]; scope: 'open' | 'others' | 'off' }) {
  useFollowBoxes(props.services, props.scope)
  return null
}

const prove = vi.mocked(proveBox)
const followBox = vi.fn()
let root: Root

async function render(services: FoundService[], scope: 'open' | 'others' | 'off'): Promise<void> {
  await act(async () => {
    root.render(<Following services={services} scope={scope} />)
  })
  await answered()
}

/** Let the boxes' answers come in, and whatever follows them. */
async function answered(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  // The list of events is cached beside localStorage: empty both.
  for (const event of knownEvents()) forgetEventRecord(event.id)
  localStorage.clear()
  // Friday open, as a phone signed in at Friday's box has it.
  acceptEvent('friday')
  expect(openEvent()).toBe('friday')
  rememberEvent(friday)
  rememberEvent(saturday)
  resetFollowForTests()
  prove.mockReset()
  followBox.mockReset()
  useStore.setState({ followBox })
  document.body.innerHTML = ''
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  vi.useRealTimers()
  for (const event of knownEvents()) forgetEventRecord(event.id)
  localStorage.clear()
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined
})

describe('the app, while it cannot reach its box', () => {
  it('goes on with the open event at the address that proves it', async () => {
    prove.mockResolvedValue({ kind: 'proven' })
    await render([at('10.0.0.9', 'friday')], 'open')
    expect(prove).toHaveBeenCalledTimes(1)
    expect(prove).toHaveBeenCalledWith(A, expect.objectContaining({ id: 'friday', key: KEY }))
    expect(followBox).toHaveBeenCalledTimes(1)
    expect(followBox).toHaveBeenCalledWith(A, { found: true })
  })

  it('does not go to a box that fails, and asks it again a minute on', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    prove.mockResolvedValue({ kind: 'refused', reason: 'signature' })
    await render([at('10.0.0.9', 'friday')], 'open')
    expect(prove).toHaveBeenCalledTimes(1)
    expect(followBox).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(RECHECK_MS - 1)
    })
    expect(prove).toHaveBeenCalledTimes(1)
    // The event's own box, there now.
    prove.mockResolvedValue({ kind: 'proven' })
    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    await answered()
    expect(prove).toHaveBeenCalledTimes(2)
    expect(followBox).toHaveBeenCalledWith(A, { found: true })
  })

  it('takes a box that cannot be asked as one that has not proven it', async () => {
    prove.mockRejectedValue(new Error('no route'))
    await render([at('10.0.0.9', 'friday')], 'open')
    expect(followBox).not.toHaveBeenCalled()
  })

  it('stays where it is when two boxes both prove it', async () => {
    prove.mockResolvedValue({ kind: 'proven' })
    await render([at('10.0.0.9', 'friday'), at('10.0.0.7', 'friday')], 'open')
    expect(prove).toHaveBeenCalledTimes(2)
    expect(followBox).not.toHaveBeenCalled()
  })

  it('asks each box once while its answer is coming', async () => {
    prove.mockReturnValue(new Promise(() => {}))
    await render([at('10.0.0.9', 'friday')], 'open')
    await render([at('10.0.0.9', 'friday'), at('10.0.0.5', 'sunday')], 'open')
    expect(prove).toHaveBeenCalledTimes(1)
  })

  it('asks nothing at all while it can reach it', async () => {
    await render([at('10.0.0.9', 'friday')], 'off')
    expect(prove).not.toHaveBeenCalled()
  })
})

describe('Your boxes', () => {
  it('moves another event to where its box proves it, and leaves the open one be', async () => {
    prove.mockResolvedValue({ kind: 'proven' })
    await render([at('10.0.0.9', 'friday'), at('10.0.0.8', 'saturday')], 'others')
    expect(prove).toHaveBeenCalledTimes(1)
    expect(prove).toHaveBeenCalledWith(
      'http://10.0.0.8:8080',
      expect.objectContaining({ id: 'saturday' })
    )
    expect(knownEvent('saturday')?.origin).toBe('http://10.0.0.8:8080')
    expect(knownEvent('friday')?.origin).toBe(friday.origin)
    expect(followBox).not.toHaveBeenCalled()
  })

  it('leaves an event where it was when the box found does not prove it', async () => {
    prove.mockResolvedValue({ kind: 'refused', reason: 'another-event' })
    await render([at('10.0.0.8', 'saturday')], 'others')
    expect(knownEvent('saturday')?.origin).toBe(saturday.origin)
  })
})
