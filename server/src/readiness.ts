import { existsSync, statfsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * What this box can actually do, right now, on this machine.
 *
 * Crewbox used to describe its capabilities in the docs, as tiers: "the
 * one-file box gives up voice, HTTPS and the installable app". That was
 * honest but useless — it told an admin what some hypothetical smaller
 * install lacks, not what the thing running in front of them can do. It also
 * went stale the moment the product changed.
 *
 * This reports the live answer instead, with the fix attached where there is
 * one. Anything that can't be delivered says so plainly rather than being
 * quietly absent.
 */

export type ReadinessState = 'ok' | 'limited' | 'off'

export interface ReadinessCheck {
  id: string
  label: string
  state: ReadinessState
  /** What's true now. */
  detail: string
  /** What to do about it, when there's something to do. */
  fix?: string
}

export interface ReadinessInput {
  /** True when the crew reached this box over TLS. */
  secure: boolean
  voice: 'embedded' | 'external' | 'off'
  dataDir: string
  crewCount: number
  /** Host the admin used, for copy that names the real address. */
  host: string
}

/** Bytes free on the data volume, or null if it can't be determined. */
export function freeBytes(dataDir: string): number | null {
  try {
    const stats = statfsSync(dataDir)
    return stats.bavail * stats.bsize
  } catch {
    return null
  }
}

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`

export function boxReadiness(input: ReadinessInput): ReadinessCheck[] {
  const checks: ReadinessCheck[] = []

  checks.push({
    id: 'chat',
    label: 'Chat, patch sheets and lighting',
    state: 'ok',
    detail: 'Working for everyone, in any phone browser, with or without internet.',
  })

  checks.push(
    input.voice === 'off'
      ? {
          id: 'voice',
          label: 'Push-to-talk voice',
          state: 'off',
          detail: 'No voice server on this box.',
          fix: 'This build ships without one. Download the release binary rather than running from source, or set LIVEKIT_URL to an SFU you run.',
        }
      : {
          id: 'voice',
          label: 'Push-to-talk voice',
          state: input.secure ? 'ok' : 'limited',
          detail:
            input.voice === 'embedded'
              ? 'Voice server running inside this box.'
              : 'Using the voice server you configured.',
          // The mic is gated on a secure context, so without HTTPS voice is
          // real but only reachable from the native apps.
          fix: input.secure
            ? undefined
            : 'Works in the Android and iOS apps now. Browsers need HTTPS before they will grant microphone access.',
        }
  )

  checks.push(
    input.secure
      ? {
          id: 'install',
          label: 'Install to home screen, offline shell',
          state: 'ok',
          detail: 'Crew can install crewbox as an app and open it with no signal.',
        }
      : {
          id: 'install',
          label: 'Install to home screen, offline shell',
          state: 'limited',
          detail: `Not available over plain http://${input.host}.`,
          fix: 'Browsers only allow this on HTTPS. Use the Android/iOS apps, or give this box a certificate for your own domain.',
        }
  )

  const apk = existsSync(join(input.dataDir, 'crewbox.apk'))
  checks.push({
    id: 'apk',
    label: 'Android app download',
    state: apk ? 'ok' : 'off',
    detail: apk
      ? 'Crew can install the Android app straight from this box.'
      : 'No Android app on this box.',
    fix: apk
      ? undefined
      : `Drop crewbox.apk into ${input.dataDir} and it appears on /connect. The Android app is what gives crew lock-screen alerts with no internet.`,
  })

  const free = freeBytes(input.dataDir)
  if (free !== null) {
    // Files and voice recordings are what fill a box up mid-event.
    const low = free < 2e9
    checks.push({
      id: 'disk',
      label: 'Disk space',
      state: low ? 'limited' : 'ok',
      detail: `${gb(free)} free for messages and files.`,
      fix: low
        ? 'Under 2 GB. Clear space before the event — file uploads stop when it runs out.'
        : undefined,
    })
  }

  checks.push({
    id: 'crew',
    label: 'Crew joined',
    state: input.crewCount > 0 ? 'ok' : 'limited',
    detail:
      input.crewCount > 0
        ? `${input.crewCount} ${input.crewCount === 1 ? 'person has' : 'people have'} joined.`
        : 'Nobody has joined yet.',
    fix:
      input.crewCount > 0 ? undefined : `Show the QR at http://${input.host}/connect, or print it.`,
  })

  return checks
}

/** One-line summary for the banner: the worst state present. */
export const worstState = (checks: ReadinessCheck[]): ReadinessState =>
  checks.some((c) => c.state === 'off')
    ? 'off'
    : checks.some((c) => c.state === 'limited')
      ? 'limited'
      : 'ok'
