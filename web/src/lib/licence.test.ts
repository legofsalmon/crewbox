import { describe, expect, it } from 'vitest'
import type { LicenceState, LicenceStatus } from './api.ts'
import { licenceBanner, licenceSummary, offerActivation } from './licence.ts'

const DAY = 86_400_000

const status = (over: Partial<LicenceStatus> = {}): LicenceStatus => ({
  policy: 'watermark',
  status: 'invalid',
  restricted: true,
  watermark: true,
  locked: false,
  verifies: true,
  requestCode: 'ABC-123',
  machine: '8b9dd6da2bcf47bdfe7ceb27c2a58680',
  key: null,
  licence: null,
  lastCheckIn: null,
  manageUrl: 'https://letissier.ie/account',
  buildDate: 0,
  ...over,
})

const licensed = (edition: string) => ({
  edition,
  name: 'Test Buyer',
  seats: 1,
  mode: 'online',
  checkInBy: Date.UTC(2026, 11, 1),
  maintenanceUntil: Date.UTC(2027, 7, 21),
  machine: '8b9dd6da2bcf47bdfe7ceb27c2a58680',
})

describe('what the Licence section says', () => {
  it('has words for every state', () => {
    for (const state of [
      'active',
      'update_required',
      'check_in_required',
      'expired',
      'wrong_machine',
      'invalid',
    ] as LicenceState[]) {
      const s = licenceSummary(status({ status: state, licence: licensed('standard') }))
      expect(s.headline, state).not.toBe('')
      expect(s.detail, state).not.toBe('')
    }
  })

  it('says a lapsed lease and an old entitlement restrict nothing', () => {
    const due = licenceSummary(
      status({ status: 'check_in_required', restricted: false, licence: licensed('standard') })
    )
    expect(due.tone).toBe('note')
    expect(due.detail).toMatch(/Nothing is restricted/)
    const old = licenceSummary(
      status({ status: 'update_required', restricted: false, licence: licensed('standard') })
    )
    expect(old.detail).toMatch(/keeps working/)
  })

  it('tells a trial from a purchase', () => {
    expect(licenceSummary(status({ status: 'active', licence: licensed('trial') })).headline).toBe(
      'Trial'
    )
    expect(
      licenceSummary(status({ status: 'active', licence: licensed('standard') })).headline
    ).toBe('Licensed')
    expect(licenceSummary(status({ status: 'expired', licence: licensed('trial') })).headline).toBe(
      'Trial ended'
    )
  })

  it('says a build that cannot verify restricts nothing', () => {
    expect(licenceSummary(status({ verifies: false })).detail).toBe('Nothing is restricted.')
  })

  it('assumes no particular offline window — every date comes from the token', () => {
    const soon = { ...licensed('standard'), checkInBy: Date.now() + 3 * DAY }
    const s = licenceSummary(status({ status: 'active', licence: soon }))
    expect(s.detail).toContain(new Date(soon.checkInBy).getFullYear().toString())
  })
})

describe('the banner', () => {
  it('shows only when the box is watermarked, and names the lock when there is one', () => {
    expect(licenceBanner(null)).toBeNull()
    expect(licenceBanner(status({ watermark: false }))).toBeNull()
    expect(licenceBanner(status())).toBe('Unlicensed copy — enter a key or start a trial')
    expect(licenceBanner(status({ locked: true }))).toMatch(/event setup is locked/)
  })
})

describe('offering activation', () => {
  it('offers it with no key, on a trial, or when restricted — and stays calm otherwise', () => {
    expect(offerActivation(status())).toBe(true)
    expect(
      offerActivation(status({ key: 'LT-CREW-A', restricted: false, licence: licensed('trial') }))
    ).toBe(true)
    expect(
      offerActivation(
        status({ key: 'LT-CREW-A', restricted: false, licence: licensed('standard') })
      )
    ).toBe(false)
  })
})
