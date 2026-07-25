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
