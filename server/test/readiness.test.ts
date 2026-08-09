import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { boxReadiness, worstState, type ReadinessInput } from '../src/readiness.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'crewbox-ready-'))
  dirs.push(dir)
  return dir
}

const input = (over: Partial<ReadinessInput> = {}): ReadinessInput => ({
  secure: false,
  voice: 'embedded',
  dataDir: tempDir(),
  crewCount: 3,
  host: '192.168.1.50',
  ...over,
})

const find = (checks: ReturnType<typeof boxReadiness>, id: string) =>
  checks.find((check) => check.id === id)!

describe('box readiness', () => {
  it('always reports the core as working', () => {
    // Chat, patch and lighting need nothing but the box itself — that's the
    // whole point, and an admin should see it stated.
    expect(find(boxReadiness(input()), 'chat').state).toBe('ok')
  })

  it('calls voice limited, not broken, on a box without HTTPS', () => {
    // The SFU is genuinely running; it's the browser mic that's gated on a
    // secure context, and the native apps are unaffected.
    const voice = find(boxReadiness(input({ secure: false })), 'voice')
    expect(voice.state).toBe('limited')
    expect(voice.fix).toMatch(/Android and iOS apps/)
    // Name the actual fix, not a vague 'needs HTTPS'.
    expect(voice.fix).toMatch(/cert\.pem/)
  })

  it('calls voice fully working once the box is on HTTPS', () => {
    const voice = find(boxReadiness(input({ secure: true })), 'voice')
    expect(voice.state).toBe('ok')
    expect(voice.fix).toBeUndefined()
  })

  it('says so plainly when the build has no voice server at all', () => {
    // Every release binary carries an SFU on every platform — macOS compiles
    // one from source at build time — so this state means a build from
    // source, and the fix says so.
    const voice = find(boxReadiness(input({ voice: 'off' })), 'voice')
    expect(voice.state).toBe('off')
    expect(voice.detail).toMatch(/No voice server/)
    expect(voice.fix).toMatch(/Download the release binary/)
  })

  it('names the real address when install is unavailable', () => {
    // Generic "needs HTTPS" copy sends admins googling; naming the address
    // they actually used tells them which thing is being talked about.
    const install = find(boxReadiness(input({ host: '10.0.0.4' })), 'install')
    expect(install.state).toBe('limited')
    expect(install.detail).toContain('10.0.0.4')
  })

  it('detects the Android app when it is on the box', () => {
    const dataDir = tempDir()
    expect(find(boxReadiness(input({ dataDir })), 'apk').state).toBe('off')

    writeFileSync(join(dataDir, 'crewbox.apk'), 'stub')
    expect(find(boxReadiness(input({ dataDir })), 'apk').state).toBe('ok')
  })

  it('detects a version-stamped apk without a rename', () => {
    // Release assets are named crewbox-v0.9.5.apk; demanding exactly
    // crewbox.apk would make every download need a rename step.
    const dataDir = tempDir()
    writeFileSync(join(dataDir, 'crewbox-v0.9.5.apk'), 'stub')
    expect(find(boxReadiness(input({ dataDir })), 'apk').state).toBe('ok')
    // Other crewbox files in the data dir are not apks.
    const empty = tempDir()
    writeFileSync(join(empty, 'crewbox.db'), 'stub')
    expect(find(boxReadiness(input({ dataDir: empty })), 'apk').state).toBe('off')
  })

  it('nudges when nobody has joined yet', () => {
    const crew = find(boxReadiness(input({ crewCount: 0 })), 'crew')
    expect(crew.state).toBe('limited')
    expect(crew.fix).toContain('/connect')
  })

  it('summarises to the worst state present', () => {
    expect(worstState([{ id: 'a', label: '', state: 'ok', detail: '' }])).toBe('ok')
    expect(
      worstState([
        { id: 'a', label: '', state: 'ok', detail: '' },
        { id: 'b', label: '', state: 'limited', detail: '' },
      ])
    ).toBe('limited')
    expect(
      worstState([
        { id: 'a', label: '', state: 'limited', detail: '' },
        { id: 'b', label: '', state: 'off', detail: '' },
      ])
    ).toBe('off')
  })
})

describe('the voice line speaks from evidence, not config', () => {
  /**
   * "Voice server running inside this box" was printed, for one real
   * afternoon, while the box's SFU was dead and a stray livekit-server from
   * an old test session answered on its port — rejecting every token this
   * box minted. These pin the panel's answer for each thing the live probe
   * can actually find.
   */
  it("calls voice off when the listener rejects this box's tokens", () => {
    const voice = find(boxReadiness(input({ voice: 'embedded', sfu: 'rejected' })), 'voice')
    expect(voice.state).toBe('off')
    expect(voice.detail).toMatch(/not this box/)
    // The squatter is invisible to everything but the operating system, so
    // the fix has to hand over the command that names it.
    expect(voice.fix).toContain('lsof')
  })

  it('calls voice off when its own SFU has stopped answering', () => {
    const voice = find(boxReadiness(input({ voice: 'embedded', sfu: 'unreachable' })), 'voice')
    expect(voice.state).toBe('off')
    expect(voice.detail).toMatch(/stopped answering/)
  })

  it('outranks the HTTPS nuance: a rejected SFU is off even on a secure box', () => {
    // 'limited' would read as "works in the apps", and it does not.
    const voice = find(
      boxReadiness(input({ secure: true, voice: 'embedded', sfu: 'rejected' })),
      'voice'
    )
    expect(voice.state).toBe('off')
  })

  it('says a checked SFU was checked', () => {
    const voice = find(boxReadiness(input({ voice: 'embedded', sfu: 'ok', secure: true })), 'voice')
    expect(voice.state).toBe('ok')
    expect(voice.detail).toMatch(/checked just now/)
  })

  it('claims nothing extra when nothing was probed', () => {
    // Tests and callers without a probe still get the old wording — the
    // stronger sentence is reserved for the case that earned it.
    const voice = find(boxReadiness(input({ voice: 'embedded', secure: true })), 'voice')
    expect(voice.state).toBe('ok')
    expect(voice.detail).not.toMatch(/checked just now/)
  })

  it('explains a start blocked by a held port instead of blaming the build', () => {
    // The old copy for voice-off sent people to download a binary they
    // already had. A held port is a different problem with a different fix.
    const voice = find(boxReadiness(input({ voice: 'off', voiceFailure: 'port-held' })), 'voice')
    expect(voice.state).toBe('off')
    expect(voice.detail).toMatch(/holding the voice port/)
    expect(voice.fix).toContain('lsof')
    expect(voice.fix).not.toMatch(/Download/)
  })

  it('points a failed start at the log', () => {
    const voice = find(boxReadiness(input({ voice: 'off', voiceFailure: 'no-start' })), 'voice')
    expect(voice.state).toBe('off')
    expect(voice.fix).toMatch(/log/)
  })

  it('does not check what it cannot reach: external SFUs stay honestly unverified', () => {
    const voice = find(boxReadiness(input({ voice: 'external', secure: true })), 'voice')
    expect(voice.state).toBe('ok')
    expect(voice.detail).toMatch(/Not checked from here/)
  })
})

describe('the crew network line on a two-network box', () => {
  it('flags the coin flip when two networks exist and none is pinned', () => {
    // The trap this exists for: the join QR takes the first address the OS
    // enumerated, which on a crew+lighting machine may be the lighting VLAN
    // — an address no crew phone can reach, failing in a way that reads as
    // "crewbox is broken" rather than "wrong network".
    const check = find(boxReadiness(input({ addresses: ['2.0.0.7', '192.168.1.50'] })), 'network')
    expect(check.state).toBe('limited')
    expect(check.detail).toContain('2.0.0.7')
    expect(check.fix).toContain('CREWBOX_IFACE')
  })

  it('reports a pinned adapter as settled, and says what that buys', () => {
    const check = find(
      boxReadiness(input({ iface: '192.168.1.50', addresses: ['192.168.1.50', '2.0.0.7'] })),
      'network'
    )
    expect(check.state).toBe('ok')
    expect(check.detail).toContain('192.168.1.50')
    expect(check.detail).toMatch(/never see its traffic/)
  })

  it('says when the pinned address is not on any adapter', () => {
    // A pulled cable or a moved DHCP lease. The box has fallen back to
    // answering everywhere rather than nowhere; this is where that is said.
    const check = find(
      boxReadiness(input({ iface: '10.0.0.99', addresses: ['2.0.0.7'] })),
      'network'
    )
    expect(check.state).toBe('limited')
    expect(check.detail).toContain('10.0.0.99')
    expect(check.detail).toContain('2.0.0.7')
  })

  it('keeps quiet-and-green on a one-network machine', () => {
    const check = find(boxReadiness(input({ addresses: ['192.168.1.50'] })), 'network')
    expect(check.state).toBe('ok')
  })

  it('says plainly when there is no network at all', () => {
    const check = find(boxReadiness(input({ addresses: [] })), 'network')
    expect(check.state).toBe('limited')
    expect(check.fix).toMatch(/Connect/)
  })
})

describe('phones staying on the crew Wi-Fi', () => {
  it('leaves the row off entirely when no responder was asked for', () => {
    // Running from source, or a box explicitly told not to. Reporting a
    // feature nobody enabled as broken is noise, not honesty.
    expect(boxReadiness(input()).find((check) => check.id === 'captive')).toBeUndefined()
  })

  it('claims only its own half when the responder is up', () => {
    // The box can prove it holds the port. It cannot see the router's DNS,
    // so the fix line carries the half it cannot verify rather than the
    // detail claiming a working end-to-end fix.
    const check = find(boxReadiness(input({ captive: { listening: true, port: 80 } })), 'captive')
    expect(check.state).toBe('ok')
    expect(check.detail).toContain('80')
    expect(check.fix).toMatch(/router/)
  })

  it('separates "on the wrong port" from "working"', () => {
    // The ordinary state of a double-clicked Mac app: the responder is up,
    // but phones only ask on port 80, so nothing reaches it. Calling that ok
    // would be the panel lying about the one thing it exists to report.
    const check = find(
      boxReadiness(input({ captive: { listening: true, port: 8880, fallback: true } })),
      'captive'
    )
    expect(check.state).toBe('limited')
    expect(check.detail).toContain('8880')
    expect(check.detail).toMatch(/nothing reaches it/)
    expect(check.fix).toMatch(/port 80 config/)
    // And it steers away from the fix everyone reaches for first.
    expect(check.fix).toMatch(/root/)
  })

  it('names the consequence, not the mechanism, when it could not listen', () => {
    const check = find(
      boxReadiness(
        input({ captive: { listening: false, reason: 'Only root may bind port 80 on macOS.' } })
      ),
      'captive'
    )
    expect(check.state).toBe('limited')
    // What an admin actually experiences: a phone that shows Wi-Fi and
    // cannot reach the box.
    expect(check.detail).toMatch(/mobile data/)
    expect(check.fix).toMatch(/root/)
  })
})
