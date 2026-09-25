import { describe, expect, it } from 'vitest'
import {
  crewCandidates,
  decideAnnounce,
  parseAnnounceSetting,
  type Adapter,
  type AnnounceInputs,
} from '../src/announce/index.ts'

/**
 * Where the box may announce itself. The rule under test is the one the
 * watchers live by: crewbox never transmits on a show network. So the
 * automatic setting speaks only on an adapter it knows is the crew's and no
 * listener shares, and every quiet answer says why in words an admin can
 * act on.
 */

const crew: Adapter = { name: 'en0', address: '10.0.0.2', netmask: '255.255.255.0' }
const lighting: Adapter = { name: 'en1', address: '2.0.0.10', netmask: '255.0.0.0' }

const inputs = (over: Partial<AnnounceInputs> = {}): AnnounceInputs => ({
  setting: 'auto',
  crewIface: '',
  adapters: [crew],
  watchers: [],
  ...over,
})

describe('which adapter', () => {
  it('announces on the only adapter a box has', () => {
    expect(decideAnnounce(inputs())).toEqual({ announce: true, adapter: crew })
  })

  it('announces on the pinned crew adapter, and only that one, on a box with several', () => {
    const decision = decideAnnounce(inputs({ crewIface: crew.address, adapters: [lighting, crew] }))
    expect(decision).toEqual({ announce: true, adapter: crew })
  })

  it('stays quiet on a box with several adapters and none chosen, and says what to do', () => {
    const decision = decideAnnounce(inputs({ adapters: [lighting, crew] }))
    expect(decision.announce).toBe(false)
    if (!decision.announce) {
      expect(decision.off).toBe(false)
      expect(decision.reason).toMatch(/2 networks/)
      expect(decision.reason).toMatch(/Choose the crew network/)
    }
  })

  it('does not guess when set to Always either: it still needs to know which network', () => {
    const decision = decideAnnounce(inputs({ setting: 'on', adapters: [lighting, crew] }))
    expect(decision.announce).toBe(false)
  })

  it('stays quiet when the pinned adapter is not there, and names the address', () => {
    const decision = decideAnnounce(inputs({ crewIface: '10.9.9.9', adapters: [crew] }))
    expect(decision).toMatchObject({ announce: false, off: false })
    if (!decision.announce) expect(decision.reason).toMatch(/10\.9\.9\.9/)
  })

  it('stays quiet with no network at all', () => {
    expect(decideAnnounce(inputs({ adapters: [] }))).toMatchObject({ announce: false, off: false })
  })
})

describe('never on a show network', () => {
  it('stays quiet when the lighting listener is on the crew adapter', () => {
    const decision = decideAnnounce(
      inputs({ watchers: [{ what: 'lighting listener', iface: crew.address }] })
    )
    expect(decision.announce).toBe(false)
    if (!decision.announce) {
      expect(decision.reason).toMatch(/lighting listener is on the crew network/)
      expect(decision.reason).toMatch(/Always/)
    }
  })

  it('stays quiet when a listener was left to the OS, which may pick the crew adapter', () => {
    const decision = decideAnnounce(
      inputs({
        crewIface: crew.address,
        adapters: [lighting, crew],
        watchers: [{ what: 'media watcher', iface: '' }],
      })
    )
    expect(decision.announce).toBe(false)
    if (!decision.announce) expect(decision.reason).toMatch(/media watcher has no adapter set/)
  })

  it('announces when every listener is on another adapter', () => {
    const decision = decideAnnounce(
      inputs({
        crewIface: crew.address,
        adapters: [lighting, crew],
        watchers: [
          { what: 'lighting listener', iface: lighting.address },
          { what: 'media watcher', iface: lighting.address },
        ],
      })
    )
    expect(decision).toEqual({ announce: true, adapter: crew })
  })

  it('announces anyway when an admin says Always', () => {
    const decision = decideAnnounce(
      inputs({ setting: 'on', watchers: [{ what: 'lighting listener', iface: crew.address }] })
    )
    expect(decision).toEqual({ announce: true, adapter: crew })
  })

  it('says nothing at all when turned off', () => {
    const decision = decideAnnounce(inputs({ setting: 'off' }))
    expect(decision).toMatchObject({ announce: false, off: true })
  })
})

describe('the setting', () => {
  it('reads the environment variable the way the other switches read theirs', () => {
    expect(parseAnnounceSetting(undefined)).toBeUndefined()
    expect(parseAnnounceSetting('')).toBeUndefined()
    expect(parseAnnounceSetting('auto')).toBe('auto')
    expect(parseAnnounceSetting('1')).toBe('on')
    expect(parseAnnounceSetting(' ON ')).toBe('on')
    expect(parseAnnounceSetting('0')).toBe('off')
    expect(parseAnnounceSetting('never')).toBe('off')
    // Junk is not a choice: the saved setting or the default decides.
    expect(parseAnnounceSetting('sometimes')).toBeUndefined()
  })
})

describe('the adapters', () => {
  it('lists the IPv4 adapters with their netmasks, leaving out loopback and link-local', () => {
    const found = crewCandidates({
      lo: [
        {
          address: '127.0.0.1',
          netmask: '255.0.0.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: true,
          cidr: '127.0.0.1/8',
        },
      ],
      en0: [
        {
          address: '10.0.0.2',
          netmask: '255.255.255.0',
          family: 'IPv4',
          mac: 'aa:bb:cc:dd:ee:ff',
          internal: false,
          cidr: '10.0.0.2/24',
        },
        {
          address: 'fe80::1',
          netmask: 'ffff:ffff:ffff:ffff::',
          family: 'IPv6',
          mac: 'aa:bb:cc:dd:ee:ff',
          internal: false,
          cidr: 'fe80::1/64',
          scopeid: 4,
        },
      ],
      en5: [
        {
          address: '169.254.3.4',
          netmask: '255.255.0.0',
          family: 'IPv4',
          mac: 'aa:bb:cc:dd:ee:00',
          internal: false,
          cidr: '169.254.3.4/16',
        },
      ],
    })
    expect(found).toEqual([crew])
  })
})
