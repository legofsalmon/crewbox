import { describe, expect, it } from 'vitest'
import { effectiveSsid } from '../src/lib/settings.ts'

// VITE_WIFI_SSID is unset under vitest, so the build-time fallback is undefined.
describe('effectiveSsid', () => {
  it('uses the runtime setting when present', () => {
    expect(effectiveSsid('CrewNet')).toBe('CrewNet')
  })

  it('treats empty/whitespace runtime values as unset', () => {
    expect(effectiveSsid('')).toBeUndefined()
    expect(effectiveSsid('   ')).toBeUndefined()
  })

  it('is undefined when nothing is configured', () => {
    expect(effectiveSsid(undefined)).toBeUndefined()
  })
})
