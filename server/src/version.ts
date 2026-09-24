import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function readPkgVersion(): string {
  // The single-binary build bakes this in — no package.json on disk there.
  if (process.env.DEPLOY_VERSION) return process.env.DEPLOY_VERSION
  try {
    const path = fileURLToPath(new URL('../package.json', import.meta.url))
    return (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version
  } catch {
    return '0.0.0'
  }
}

function readCommit(): string {
  // DEPLOY_COMMIT lets the deploy pin an exact build; otherwise read git.
  if (process.env.DEPLOY_COMMIT) return process.env.DEPLOY_COMMIT
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return 'unknown'
  }
}

/** Matches the web build's version string so the two can be compared. */
export const APP_VERSION = `${readPkgVersion()}+${readCommit()}`

/**
 * When this build was released, as unix seconds — what a licence's
 * `maintUntil` is compared against. A build released at or before it is
 * entitled for ever; a newer one says "update window ended" and nothing more.
 *
 * Baked into the box binary by scripts/build-box.mjs (esbuild replaces
 * `process.env.DEPLOY_BUILD_DATE` with a literal), so it is a property of the
 * build rather than of a file anyone can edit. Running from source there is
 * no build, and 0 is the honest answer: it is never after anybody's
 * entitlement, so a source checkout never claims its updates have lapsed.
 */
export const BUILD_DATE: number = (() => {
  const value = Number(process.env.DEPLOY_BUILD_DATE)
  return Number.isInteger(value) && value > 0 ? value : 0
})()
