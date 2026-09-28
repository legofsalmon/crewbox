import { describe, expect, it } from 'vitest'
import { dnsConfigFile, dnsPlan, probesConfigFile } from '../src/dnsconfig.ts'

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
    expect(file).toContain(`\n${plan.dnsmasq}\n`)
    // The other systems' lines ride along as comments: see the next test.
    expect(file).toContain(`\n# ${plan.hosts}\n`)
    expect(file).toContain(`\n# ${plan.zone}\n`)
    // The reasoning is the part that stops this being undone later.
    expect(file).toMatch(/no uplink/)
    expect(file).toMatch(/private addresses/)
    // And a way to tell whether it worked.
    expect(file).toContain(`https://${plan.hostname}`)
  })

  it('is a dnsmasq config from top to bottom', () => {
    // Its dnsmasq section says to save it as /etc/dnsmasq.d/crewbox.conf, so
    // that is what happens to the whole file. dnsmasq will not start on a line
    // it cannot read, and on OpenWRT the same process hands out DHCP: one
    // hosts line in here used to take the whole crew network down. Every line
    // is blank, a comment, or an address= override.
    for (const file of [dnsConfigFile(plan), probesConfigFile('192.168.1.50')]) {
      for (const line of file.split('\n')) {
        expect(line).toMatch(/^(|#.*|address=\/[^/\s]+\/[\d.]+)$/)
      }
    }
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
    expect(file).toContain(`\n${plan.probes.dnsmasq}\n`)
    // Marked optional, because it changes what phones report about the
    // network. Saving the whole file takes it too, so the file says how to
    // leave it out.
    expect(file).toMatch(/OPTIONAL/)
    expect(file).toMatch(/to leave them out/)
    expect(file).toMatch(/mobile network|mobile data/)
  })

  it('still gives a box with no certificate the probe block', () => {
    // "Phones stay on this Wi-Fi" asks for this file on every box. A plain
    // http box has no name to point anywhere, but its phones still drop to
    // mobile data, so it gets the half that applies rather than a 404.
    const file = probesConfigFile('192.168.1.50')
    expect(file).toContain('address=/captive.apple.com/192.168.1.50')
    expect(file).toMatch(/OPTIONAL/)
    expect(file).toMatch(/no certificate/)
    // Nothing that pretends there is a name.
    expect(file).not.toMatch(/https:\/\//)
    expect(file).not.toMatch(/IN\tA/)
  })

  it('puts the same probe block in both files', () => {
    const tail = (file: string) => file.slice(file.indexOf('# OPTIONAL'))
    expect(tail(probesConfigFile('192.168.1.50'))).toBe(tail(dnsConfigFile(plan)))
  })
})
