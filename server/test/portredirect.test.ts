import { describe, expect, it } from 'vitest'
import { redirectConfigFile, redirectPlan } from '../src/portredirect.ts'

/**
 * The rule that gets port 80 to an unprivileged responder.
 *
 * Verified by hand on macOS 15 before this was written: with the rule loaded
 * and the box on the fallback port, an iPhone kept its Wi-Fi indicator and
 * reached the box. What is checked here is that the generated text is that
 * rule, with this box's own adapter and address in it — the two fields
 * nobody can guess and which fail silently when wrong.
 */

const plan = redirectPlan({ iface: 'en6', address: '192.168.200.77', port: 8880 })

describe('the redirect rule', () => {
  it('is scoped to the crew adapter, not every interface', () => {
    // Without `on en6` the rule applies everywhere, including a lighting VLAN
    // this box has no business rewriting packets on.
    expect(plan.rule).toBe(
      'rdr pass on en6 inet proto tcp from any to any port 80 -> 192.168.200.77 port 8880'
    )
  })

  it('comes with a way to load it and a way to undo it', () => {
    expect(plan.load).toContain('pfctl -ef -')
    expect(plan.load).toContain(plan.rule)
    expect(plan.unload).toBe('sudo pfctl -d')
  })

  it('offers Linux the capability first, and a redirect only as a fallback', () => {
    // setcap is strictly better there: the box takes port 80 directly and no
    // packet rewriting is involved at all.
    const file = redirectConfigFile(plan)
    expect(file).toContain('cap_net_bind_service')
    expect(file.indexOf('cap_net_bind_service')).toBeLessThan(file.indexOf(plan.linux))
  })
})

describe('the generated file', () => {
  const file = redirectConfigFile(plan)

  it('carries the real adapter, address and port throughout', () => {
    expect(file).toContain('en6')
    expect(file).toContain('192.168.200.77')
    expect(file).toContain('8880')
  })

  it('warns that curl on the same machine is not a valid test', () => {
    // pf does not redirect traffic the machine sends to itself, so the
    // obvious check fails while the rule is working perfectly. Whoever hits
    // that without warning loses twenty minutes to it.
    expect(file).toMatch(/curl/)
    expect(file).toMatch(/Test from\s+a phone|Do not test with curl/)
  })

  it('says why running the box as root is the wrong fix', () => {
    // It is the first thing anyone reaches for, and it leaves a process
    // handling uploads and untrusted traffic at root for the whole event.
    expect(file).toMatch(/sudo would also work|worse idea/)
    expect(file).toMatch(/untrusted crew traffic/)
  })

  it('explains how to keep it across a reboot', () => {
    expect(file).toContain('/etc/pf.anchors/crewbox')
    expect(file).toContain('pfctl -f /etc/pf.conf -E')
  })

  it('offers the router as an alternative to touching this machine', () => {
    expect(file).toMatch(/router/)
  })
})
