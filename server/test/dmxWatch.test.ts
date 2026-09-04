import { describe, expect, it } from 'vitest'
import type { DmxStateMessage, DmxLevelsMessage, ServerMessage } from '@crewbox/shared'
import { Hub } from '../src/hub.ts'
import { DmxListener } from '../src/dmx/listener.ts'
import type { Store } from '../src/store.ts'
import type { DmxFrame } from '../src/dmx/types.ts'

/**
 * What a watching client is actually told.
 *
 * A rig runs at 44 Hz and a phone on festival Wi-Fi cannot have that, so the
 * whole point of this layer is what it *doesn't* send. These drive the hub's
 * push directly rather than through a socket, so the sampling and the
 * change-detection are testable without timing anything.
 */

const listener = (): DmxListener => new DmxListener({ mode: 'off', universes: [], artnetBase: 1 })

const frame = (over: Partial<DmxFrame> = {}): DmxFrame => ({
  protocol: 'sacn',
  wireUniverse: 1,
  sourceId: 'console-a',
  sourceName: 'grandMA3',
  priority: 100,
  sequence: 1,
  sequenced: true,
  slots: new Uint8Array(512),
  syncAddress: 0,
  forceSync: false,
  preview: false,
  terminated: false,
  ...over,
})

const slots = (lit: Record<number, number>): Uint8Array => {
  const out = new Uint8Array(512)
  for (const [address, level] of Object.entries(lit)) out[Number(address) - 1] = level
  return out
}

/**
 * A hub with a fake socket, so `pushDmx` can be driven straight. The store is
 * never reached by this path — nothing here touches chat.
 */
const watcher = (dmx: DmxListener, universes: number[], levels = false) => {
  const sent: ServerMessage[] = []
  const hub = new Hub(
    {} as Store,
    { info() {}, warn() {}, error() {} } as never,
    () => ({ eventName: '', wifiSsid: '', voiceEnabled: false, modules: [] }),
    undefined,
    false,
    dmx
  )
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: (payload: string) => sent.push(JSON.parse(payload) as ServerMessage),
  }
  const conn = {
    ws,
    user: { id: 'u1' },
    alive: true,
    remote: false,
    sends: [],
    dmxUniverses: universes,
    dmxLevels: levels,
    dmxSent: new Map<number, Uint8Array>(),
    dmxEverLit: new Map<number, string>(),
  }
  // `pushDmx` is private by design — nothing outside the hub should call it.
  const push = () => (hub as never as { pushDmx: (c: unknown) => void }).pushDmx(conn)
  /** What a client's `dmxWatch` frame does, through the real handler. */
  const watch = (next: number[], wantLevels = levels) =>
    (hub as never as { onMessage: (c: unknown, m: unknown) => void }).onMessage(conn, {
      type: 'dmxWatch',
      universes: next,
      levels: wantLevels,
    })
  return { push, watch, sent, conn }
}

const states = (sent: ServerMessage[]) =>
  sent.filter((m): m is DmxStateMessage => m.type === 'dmxState')
const levelMessages = (sent: ServerMessage[]) =>
  sent.filter((m): m is DmxLevelsMessage => m.type === 'dmxLevels')

describe('what a watching client hears', () => {
  it('reports the universes it asked about, and no others', () => {
    const dmx = listener()
    dmx.state.apply(frame({ wireUniverse: 1 }), 1000)
    dmx.state.apply(frame({ wireUniverse: 5, sourceId: 'b' }), 1000)
    const { push, sent } = watcher(dmx, [1])
    push()
    expect(states(sent)[0].universes.map((u) => u.universe)).toEqual([1])
  })

  it('carries both universe numbers so a wrong mapping is visible', () => {
    const dmx = listener()
    dmx.state.apply(frame({ protocol: 'artnet', wireUniverse: 0, sequenced: false }), 1000)
    const { push, sent } = watcher(dmx, [1])
    push()
    const [universe] = states(sent)[0].universes
    expect(universe.universe).toBe(1)
    expect(universe.wireUniverse).toBe(0)
  })

  it('names the source being believed and flags a tie', () => {
    const dmx = listener()
    dmx.state.apply(frame({ sourceId: 'a', sourceName: 'grandMA3' }), 1000)
    const { push, sent } = watcher(dmx, [1])
    push()
    expect(states(sent)[0].universes[0].source).toBe('grandMA3')
    expect(states(sent)[0].universes[0].conflict).toBe(false)

    dmx.state.apply(frame({ sourceId: 'b', sourceName: 'Spare Desk' }), 1001)
    push()
    expect(states(sent).at(-1)!.universes[0].conflict).toBe(true)
  })

  it('says plainly when the box is not listening at all', () => {
    const hub = watcher(undefined as never, [1])
    // A box with no listener still answers, rather than leaving a client
    // waiting for a message that will never come.
    const { push, sent } = hub
    push()
    expect(states(sent)[0].listening).toBe(false)
    expect(states(sent)[0].universes).toEqual([])
  })
})

describe('not saying the same thing twice', () => {
  it('stays quiet while nothing changes', () => {
    const dmx = listener()
    dmx.state.apply(frame({ slots: slots({ 1: 255 }) }), 1000)
    const { push, sent } = watcher(dmx, [1])
    push()
    expect(states(sent)).toHaveLength(1)
    push()
    push()
    // A rig sitting on a look would otherwise cost four messages a second
    // per phone for no information at all.
    expect(states(sent)).toHaveLength(1)
  })

  it('speaks again when a new address lights for the first time', () => {
    const dmx = listener()
    dmx.state.apply(frame({ sequence: 1, slots: slots({ 1: 255 }) }), 1000)
    const { push, sent } = watcher(dmx, [1])
    push()
    dmx.state.apply(frame({ sequence: 2, slots: slots({ 1: 255, 40: 10 }) }), 1100)
    push()
    expect(states(sent)).toHaveLength(2)
  })

  it('speaks again when a second source appears', () => {
    const dmx = listener()
    dmx.state.apply(frame({ sourceId: 'a' }), 1000)
    const { push, sent } = watcher(dmx, [1])
    push()
    dmx.state.apply(frame({ sourceId: 'b' }), 1001)
    push()
    expect(states(sent)).toHaveLength(2)
  })
})

describe('levels', () => {
  it('sends none unless they were asked for', () => {
    const dmx = listener()
    dmx.state.apply(frame({ slots: slots({ 1: 255 }) }), 1000)
    const { push, sent } = watcher(dmx, [1], false)
    push()
    expect(levelMessages(sent)).toHaveLength(0)
  })

  it('opens with everything that is on, not just the next change', () => {
    // A phone arriving mid-show should see the look, not wait for a cue.
    const dmx = listener()
    dmx.state.apply(frame({ slots: slots({ 1: 255, 10: 128 }) }), 1000)
    const { push, sent } = watcher(dmx, [1], true)
    push()
    const [first] = levelMessages(sent)
    expect(first.full).toBe(true)
    expect(first.values).toEqual([
      [1, 255],
      [10, 128],
    ])
  })

  it('then sends only what moved', () => {
    const dmx = listener()
    dmx.state.apply(frame({ sequence: 1, slots: slots({ 1: 255, 10: 128 }) }), 1000)
    const { push, sent } = watcher(dmx, [1], true)
    push()
    dmx.state.apply(frame({ sequence: 2, slots: slots({ 1: 255, 10: 64 }) }), 1100)
    push()
    const last = levelMessages(sent).at(-1)!
    expect(last.full).toBe(false)
    expect(last.values).toEqual([[10, 64]])
  })

  it('says nothing at all when nothing moved', () => {
    const dmx = listener()
    dmx.state.apply(frame({ sequence: 1, slots: slots({ 1: 255 }) }), 1000)
    const { push, sent } = watcher(dmx, [1], true)
    push()
    const before = levelMessages(sent).length
    push()
    expect(levelMessages(sent)).toHaveLength(before)
  })

  it('caps a chase rather than letting it saturate a phone', () => {
    // Everything changing every frame is a real thing rigs do. What does not
    // fit waits for the next tick, so nothing is lost — it is a quarter of a
    // second late, which for a level readout is indistinguishable.
    const dmx = listener()
    dmx.state.apply(frame({ sequence: 1, slots: new Uint8Array(512) }), 1000)
    const { push, sent } = watcher(dmx, [1], true)
    push()
    const everything = new Uint8Array(512).fill(200)
    dmx.state.apply(frame({ sequence: 2, slots: everything }), 1100)
    push()
    const burst = levelMessages(sent).at(-1)!
    expect(burst.values.length).toBeLessThanOrEqual(96)

    // ...and the rest arrives on the following ticks rather than being lost.
    push()
    push()
    push()
    push()
    push()
    push()
    const total = new Set(
      levelMessages(sent)
        .filter((m) => !m.full)
        .flatMap((m) => m.values.map(([address]) => address))
    )
    expect(total.size).toBe(512)
  })
})

/**
 * Subscribing again, to universes the box has never heard from.
 *
 * `pushDmx` only sends when the summary changed, which is right for a tick
 * and wrong for a new watch: the summary for a set of silent universes is
 * the same as last time, so nothing went out. The client has just set
 * `listening: false` in its own cleanup, so the live bar reads "this box is
 * not listening to Art-Net or sACN" while the admin panel says it is
 * listening on sixteen universes. At get-in, before the desk is outputting,
 * that is exactly where an LX programmer lands.
 */
describe('watching again', () => {
  it('always answers a fresh watch, even when nothing has been heard', () => {
    const dmx = listener()
    const { watch, sent } = watcher(dmx, [])
    watch([1, 2])
    expect(states(sent)).toHaveLength(1)
    sent.length = 0
    // The same silent universes again. This used to send nothing at all.
    watch([1, 2])
    expect(states(sent)).toHaveLength(1)
    expect(states(sent)[0]!.listening).toBe(true)
  })

  it('answers a fresh watch when the rig is running, too', () => {
    const dmx = listener()
    dmx.state.apply(frame({ wireUniverse: 1 }), 1000)
    const { watch, sent } = watcher(dmx, [])
    watch([1])
    sent.length = 0
    watch([1])
    expect(states(sent)).toHaveLength(1)
    expect(states(sent)[0]!.universes.map((u) => u.universe)).toEqual([1])
  })

  it('still says nothing on an ordinary tick with no change', () => {
    // The saving that makes this layer worth having: a rig at 44 Hz must not
    // become 44 messages a second per phone.
    const dmx = listener()
    dmx.state.apply(frame({ wireUniverse: 1 }), 1000)
    const { push, sent } = watcher(dmx, [1])
    push()
    sent.length = 0
    push()
    expect(states(sent)).toHaveLength(0)
  })
})
