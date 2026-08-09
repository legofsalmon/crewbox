import { describe, expect, it } from 'vitest'
import { dnsConfigFile, dnsPlan } from '../src/dnsconfig.ts'

/**
 * The generated config is the fix for the one check an admin cannot act on
 * from memory. What matters is that it is correct enough to paste without
 * editing, and that it explains why it has to be local — otherwise the next
 * person "simplifies" it into a public A record and it stops working in a
 * field.
 */

describe('local DNS config', () => {
  const plan = dnsPlan('chat.letissier.ie', '192.168.1.50')

  it('writes a dnsmasq override that beats the upstream answer', () => {
    // address=/name/ip wins over whatever public DNS says, which matters most
    // on a domain with a wildcard — there, the name already resolves, just
    // not to the box.
    expect(plan.dnsmasq).toBe('address=/chat.letissier.ie/192.168.1.50')
  })

  it('writes a hosts line for the laptop that needs it before the router does', () => {
    expect(plan.hosts).toBe('192.168.1.50\tchat.letissier.ie')
  })

  it('writes a zone line for a venue with its own resolver', () => {
    expect(plan.zone).toBe('chat.letissier.ie.\tIN\tA\t192.168.1.50')
  })

  it('produces a file that carries every form plus why it is local', () => {
    const file = dnsConfigFile(plan)
    expect(file).toContain(plan.dnsmasq)
    expect(file).toContain(plan.hosts)
    expect(file).toContain(plan.zone)
    // The reasoning is the part that stops this being undone later.
    expect(file).toMatch(/no uplink/)
    expect(file).toMatch(/private addresses/)
    // And a way to tell whether it worked.
    expect(file).toContain(`https://${plan.hostname}`)
  })

  it('points the OS connectivity probes at the box too', () => {
    // The other half of "phones stay on the crew Wi-Fi": without these the
    // responder on port 80 never sees a request, because nothing resolves to
    // it. Every hostname gets the box's address, not the certificate's name.
    for (const host of plan.probes.hostnames) {
      expect(plan.probes.dnsmasq).toContain(`address=/${host}/192.168.1.50`)
      expect(plan.probes.hosts).toContain(`192.168.1.50\t${host}`)
    }
    const file = dnsConfigFile(plan)
    expect(file).toContain('captive.apple.com')
    // Marked optional and separate, because it changes what phones report
    // about the network — an admin should choose it deliberately.
    expect(file).toMatch(/OPTIONAL/)
    expect(file).toMatch(/mobile network|mobile data/)
  })
})
