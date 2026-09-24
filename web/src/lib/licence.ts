import type { LicenceStatus } from './api.ts'

/**
 * What the Licence section says, in words, for each state the box can be in.
 *
 * Pure so every state can be asserted without rendering the panel. Two rules
 * for the wording:
 *
 * - A state that restricts nothing says so. `check_in_required` on a box that
 *   has been in a field for three weeks is the normal case, and a panel that
 *   reads it as a fault teaches an admin to ignore the one that is.
 * - Nothing here assumes how long an offline window or a trial is. Both are
 *   set per licence by the service, so every date comes from the token.
 */

export type LicenceTone = 'ok' | 'note' | 'problem'

export interface LicenceSummary {
  headline: string
  detail: string
  tone: LicenceTone
}

export const formatDay = (ms: number): string =>
  new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

export function licenceSummary(s: LicenceStatus): LicenceSummary {
  if (!s.verifies) {
    return {
      headline: 'Licence checks are off in this build',
      detail: 'Nothing is restricted.',
      tone: 'note',
    }
  }
  const l = s.licence
  const trial = l?.edition === 'trial'
  switch (s.status) {
    case 'active':
      return trial
        ? {
            headline: 'Trial',
            detail: `Ends ${l ? formatDay(l.checkInBy) : 'soon'}. Enter a key any time to keep going.`,
            tone: 'ok',
          }
        : {
            headline: 'Licensed',
            detail: [
              l?.name,
              l ? `${l.seats} seat${l.seats === 1 ? '' : 's'}` : null,
              l ? `next check-in by ${formatDay(l.checkInBy)}` : null,
            ]
              .filter(Boolean)
              .join(' · '),
            tone: 'ok',
          }
    case 'update_required':
      return {
        headline: 'Licensed — update window ended',
        detail: `This build is newer than the updates your licence includes (to ${
          l ? formatDay(l.maintenanceUntil) : 'its end date'
        }). It keeps working; renew to keep updating.`,
        tone: 'note',
      }
    case 'check_in_required':
      return {
        headline: 'Licensed — check-in due',
        detail:
          'Nothing is restricted. Check in when the box next has internet, or paste a fresh token from your account below.',
        tone: 'note',
      }
    case 'expired':
      return {
        headline: 'Trial ended',
        detail: 'Enter a key to keep this box licensed.',
        tone: 'problem',
      }
    case 'wrong_machine':
      return {
        headline: 'Licensed to another box',
        detail:
          'This licence was activated on a different machine — often a restored backup. Activate it here, or release the other box from your account page.',
        tone: 'problem',
      }
    default:
      return {
        headline: 'Unlicensed',
        detail: 'Enter a licence key, or start a free trial.',
        tone: s.restricted ? 'problem' : 'note',
      }
  }
}

/** The banner's words, or null when there is no banner. */
export function licenceBanner(s: LicenceStatus | null): string | null {
  if (!s?.watermark) return null
  return s.locked
    ? 'Unlicensed copy — event setup is locked until you enter a key or start a trial'
    : 'Unlicensed copy — enter a key or start a trial'
}

/** Whether to offer the key and trial forms, rather than keep the section calm. */
export function offerActivation(s: LicenceStatus): boolean {
  return !s.key || s.restricted || s.licence?.edition === 'trial'
}
