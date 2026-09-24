import { describe, expect, it } from 'vitest'
import { adapterMissing, describeAnnounce, listeningMode } from './adminnetwork.ts'
import type { AdminNetwork, AnnounceStatus } from './api.ts'

const network = (over: Partial<AdminNetwork> = {}): AdminNetwork => ({
  adapters: [{ name: 'eth0', address: '192.168.1.50' }],
  saved: { crewIface: '', dmxMode: '', dmxIface: '', dmxUniverses: '' },
  fromEnv: { iface: false, dmxMode: false, dmxIface: false, dmxUniverses: false },
  advertised: '192.168.1.50',
  restartNeeded: false,
  ...over,
})

describe('what the box is actually listening to', () => {
  it('is what the environment set, when the environment set it', () => {
    // The case the form got wrong. CREWBOX_DMX=sacn with nothing ever saved
    // leaves the saved mode empty, so the form concluded lighting was off
    // and hid the adapter and universes fields — the only two an operator on
    // such a box can set, because those are not pinned by the environment.
    const env = network({
      fromEnv: { iface: false, dmxMode: true, dmxIface: false, dmxUniverses: false },
      effective: { iface: '', dmxMode: 'sacn', dmxIface: '', dmxUniverses: '1-16' },
    })
    expect(listeningMode(env, 'off')).toBe('sacn')
  })

  it('is what is in the form, when the environment has not pinned it', () => {
    // Which is the ordinary case: the operator is editing it right now, and
    // the fields must appear and disappear as they change the dropdown.
    expect(listeningMode(network(), 'artnet')).toBe('artnet')
    expect(listeningMode(network(), 'off')).toBe('off')
  })

  it('falls back to the form against a box too old to say', () => {
    // `effective` is optional so an older box still parses. It sends none.
    const old = network({
      fromEnv: { iface: false, dmxMode: true, dmxIface: false, dmxUniverses: false },
    })
    expect(listeningMode(old, 'off')).toBe('off')
  })
})

describe('an adapter the box cannot see', () => {
  it('is spotted, so the select can still show it', () => {
    // A dongle left in the van. Without an option to match, the select fell
    // back to the blank one — so the panel said "All networks" while the box
    // was pinned to an adapter that is not there.
    expect(adapterMissing([{ address: '192.168.1.50' }], '10.0.0.9')).toBe(true)
  })

  it('is not reported for one that is present', () => {
    expect(adapterMissing([{ address: '192.168.1.50' }], '192.168.1.50')).toBe(false)
  })

  it('is not reported for no selection at all', () => {
    // Blank is "all networks", which is a real answer and not a missing one.
    expect(adapterMissing([{ address: '192.168.1.50' }], '')).toBe(false)
  })
})

describe('whether the apps can find the box', () => {
  const status = (over: Partial<AnnounceStatus>): AnnounceStatus => ({
    state: 'announcing',
    setting: 'auto',
    fromEnv: false,
    ...over,
  })

  it('names what the apps list it as, and where', () => {
    const line = describeAnnounce(
      status({ name: 'Ashton Court 2026', address: '10.0.0.2', adapter: 'en0' })
    )
    expect(line).toMatch(/\u201cAshton Court 2026\u201d on 10\.0\.0\.2/)
  })

  it("passes on the box's reason for staying quiet, which only it knows", () => {
    const reason = 'Quiet, because the lighting listener is on the crew network too.'
    expect(describeAnnounce(status({ state: 'quiet', reason }))).toBe(reason)
    expect(describeAnnounce(status({ state: 'failed', reason: 'Could not open it.' }))).toBe(
      'Could not open it.'
    )
  })

  it('says what off means for the crew', () => {
    expect(describeAnnounce(status({ state: 'off', setting: 'off' }))).toMatch(/address or the QR/)
  })
})
