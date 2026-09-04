import type { NetworkInterfaceInfo } from 'node:os'
import { describe, expect, it } from 'vitest'
import { isIpv4, isUnicastIpv4 } from '@crewbox/shared'
import { isOwnBroadcast } from '../src/video/discovery.ts'
import { VideoStore } from '../src/video/store.ts'

/**
 * Which addresses the box will point a reader at.
 *
 * `isIpv4` says a string is four octets. `224.0.0.1` is four octets — it is
 * the all-hosts multicast group — and Linux sends UDP to a multicast
 * destination quite happily without `SO_BROADCAST`, out of whatever interface
 * the routing table fancies. On this box that is the crew Wi-Fi. Adding a
 * processor and arming it are both session-authed, so anybody on site could
 * turn the twenty-second SNMP GET into a segment-wide beacon by typing one
 * thing, on a box whose own rule is that segment-wide traffic needs the admin
 * password.
 *
 * Confirmed on this Node: `socket.send(..., '224.0.0.1')` is accepted and the
 * datagram leaves.
 */

const iface = (address: string, netmask: string): NetworkInterfaceInfo =>
  ({
    address,
    netmask,
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: null,
  }) as unknown as NetworkInterfaceInfo

const interfaces = () => ({ eth0: [iface('10.0.30.5', '255.255.255.0')] })

const store = () => {
  const settings = new Map<string, string>()
  return new VideoStore(
    {
      getSetting: (k) => settings.get(k),
      setSetting: (k, v) => void settings.set(k, v),
    },
    () => 1_700_000_000_000,
    interfaces as unknown as typeof import('node:os').networkInterfaces
  )
}

const add = (host: string) => store().add({ host, addedBy: 'someone-with-a-session' })

describe('one host, addressed on purpose', () => {
  it('takes an ordinary processor address', () => {
    for (const host of ['10.0.30.11', '192.168.1.50', '172.16.4.9', '169.254.7.7']) {
      expect(isUnicastIpv4(host), host).toBe(true)
    }
  })

  it('keeps link-local, because a patched cable with no DHCP lands there', () => {
    // A real way to work, and refusing it would cost somebody a wall.
    expect(isUnicastIpv4('169.254.100.1')).toBe(true)
    expect(add('169.254.100.1')).toMatchObject({ ok: true })
  })

  it('refuses multicast', () => {
    for (const host of ['224.0.0.1', '224.0.0.251', '239.255.255.250', '232.1.2.3']) {
      expect(isIpv4(host), `${host} is still four octets`).toBe(true)
      expect(isUnicastIpv4(host), host).toBe(false)
    }
  })

  it('refuses the limited broadcast and the reserved range above it', () => {
    expect(isUnicastIpv4('255.255.255.255')).toBe(false)
    expect(isUnicastIpv4('240.0.0.1')).toBe(false)
  })

  it('refuses this-network and loopback', () => {
    // Not a processor either way, and loopback points the reader at the box's
    // own services.
    expect(isUnicastIpv4('0.0.0.0')).toBe(false)
    expect(isUnicastIpv4('127.0.0.1')).toBe(false)
  })

  it('still refuses anything that is not an address at all', () => {
    for (const host of ['wall.local', '10.0.30', '10.0.30.11/24', '', '999.1.1.1']) {
      expect(isUnicastIpv4(host), host).toBe(false)
    }
  })
})

describe('the broadcast an address alone cannot reveal', () => {
  it('knows the broadcast of a subnet the box is on', () => {
    // 10.0.30.255 is a host on a /16 and everybody on a /24. Only the netmask
    // says which, which is why this check lives where the netmask does.
    expect(isOwnBroadcast('10.0.30.255', interfaces)).toBe(true)
  })

  it('leaves alone an address that only looks like one', () => {
    expect(isOwnBroadcast('10.0.31.255', interfaces)).toBe(false)
    expect(isOwnBroadcast('10.0.30.11', interfaces)).toBe(false)
  })
})

describe('adding a processor', () => {
  it('refuses a multicast group', () => {
    expect(add('224.0.0.1')).toEqual({
      ok: false,
      reason: 'that address is a group or a broadcast, not one processor',
    })
  })

  it("refuses this box's own subnet broadcast", () => {
    expect(add('10.0.30.255')).toEqual({
      ok: false,
      reason: 'that is the broadcast address of a network this box is on',
    })
  })

  it('still takes the address somebody actually meant', () => {
    expect(add('10.0.30.11')).toMatchObject({ ok: true })
  })
})
