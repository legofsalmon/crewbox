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
  })

  it('calls voice fully working once the box is on HTTPS', () => {
    const voice = find(boxReadiness(input({ secure: true })), 'voice')
    expect(voice.state).toBe('ok')
    expect(voice.fix).toBeUndefined()
  })

  it('says so plainly when the build has no voice server at all', () => {
    const voice = find(boxReadiness(input({ voice: 'off' })), 'voice')
    expect(voice.state).toBe('off')
    expect(voice.detail).toMatch(/No voice server/)
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
