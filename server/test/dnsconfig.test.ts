import { describe, expect, it } from 'vitest'
import { dnsConfigFile, dnsPlan, probesConfigFile, routerosScript } from '../src/dnsconfig.ts'

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

  it('writes RouterOS commands that replace the entry instead of stacking one', () => {
    // A MikroTik has no dnsmasq. Pasting again after the box's address moved
    // must leave one answer, not last event's beside this one. The short TTL
    // is what gets the fix to phones that already asked: RouterOS would
    // otherwise tell them to keep the old answer for a day.
    expect(plan.routeros).toBe(
      '/ip dns static remove [find name=chat.letissier.ie]\n' +
        '/ip dns static add name=chat.letissier.ie address=192.168.1.50 ttl=1m comment=crewbox'
    )
    // match-subdomain would make a RouterOS 6 router reject the line.
    expect(plan.routeros).not.toMatch(/match-subdomain/)
  })

  it('gives RouterOS a script that is nothing but RouterOS', () => {
    // Pasted into a terminal or run with /import as it stands, so a dnsmasq
    // or hosts line in it is an error on the router. It also turns on
    // answering the LAN, or the entries exist and no phone can ask for them.
    for (const script of [
      routerosScript('chat.letissier.ie', '192.168.1.50'),
      routerosScript(undefined, '192.168.1.50'),
    ]) {
      const lines = script.split('\n')
      for (const line of lines) expect(line).toMatch(/^(|#.*|\/ip dns .*)$/)
      expect(lines).toContain('/ip dns set allow-remote-requests=yes')
      expect(script).toContain(plan.probes.routeros)
      expect(script).toMatch(/OPTIONAL/)
    }
    expect(routerosScript('chat.letissier.ie', '192.168.1.50')).toContain(plan.routeros)
    // No certificate, no name: only the probe entries.
    expect(routerosScript(undefined, '192.168.1.50')).not.toContain('name=chat.')
  })

  it('keeps RouterOS out of the dnsmasq file', () => {
    // That one is saved whole into dnsmasq, which will not start on a line it
    // cannot read. It points MikroTik owners at their own download instead.
    for (const file of [dnsConfigFile(plan), probesConfigFile('192.168.1.50')]) {
      expect(file).not.toContain('/ip dns')
    }
    expect(dnsConfigFile(plan)).toMatch(/Download for MikroTik/)
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
      expect(plan.probes.routeros).toContain(
        `/ip dns static add name=${host} address=192.168.1.50 ttl=1m comment=crewbox`
      )
      expect(plan.probes.hosts).toContain(`192.168.1.50\t${host}`)
    }
    const file = dnsConfigFile(plan)
    expect(file).toContain('captive.apple.com')
    // Marked optional and separate, because it changes what phones report
    // about the network — an admin should choose it deliberately.
    expect(file).toMatch(/OPTIONAL/)
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
