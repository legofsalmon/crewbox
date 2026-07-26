import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * TLS for the box.
 *
 * HTTPS isn't a nicety here — it's the gate on three things browsers refuse
 * to do over plain http://: grant a microphone, register a service worker,
 * and offer "add to home screen". So a box without a certificate can serve
 * chat and paperwork perfectly but can never give a browser voice or an
 * offline shell. That's a browser security rule, not something packaging can
 * remove.
 *
 * What packaging *can* remove is Caddy. The box reads a certificate out of
 * its own data directory and serves TLS itself, so the admin's job shrinks
 * from "install and configure a reverse proxy" to "put two files here".
 *
 * Where the certificate comes from is deliberately not our business: certbot,
 * a wildcard the production company already owns, whatever the venue's IT
 * department hands over. Anything that yields a PEM works.
 */

export const CERT_FILE = 'cert.pem'
export const KEY_FILE = 'key.pem'

export interface TlsMaterial {
  cert: Buffer
  key: Buffer
  /** Full chain, when the deployment supplied one separately. */
  ca?: Buffer
}

export interface TlsResult {
  tls: TlsMaterial | null
  /** Why there's no TLS, when there isn't — surfaced to the admin verbatim. */
  reason?: string
}

/**
 * Load the certificate pair from the data directory, if it's there.
 *
 * Every failure is soft and explained. A box that refused to start because a
 * certificate was unreadable would be a box that's down during load-in, and
 * the fallback — plain HTTP, everything except browser mic and install — is
 * a working product.
 */
export function loadTls(dataDir: string): TlsResult {
  const certPath = join(dataDir, CERT_FILE)
  const keyPath = join(dataDir, KEY_FILE)

  const hasCert = existsSync(certPath)
  const hasKey = existsSync(keyPath)
  if (!hasCert && !hasKey) return { tls: null }
  if (!hasCert || !hasKey) {
    return {
      tls: null,
      reason: `Found ${hasCert ? CERT_FILE : KEY_FILE} but not ${hasCert ? KEY_FILE : CERT_FILE} in ${dataDir}. TLS needs both.`,
    }
  }

  try {
    const cert = readFileSync(certPath)
    const key = readFileSync(keyPath)
    if (!cert.includes('BEGIN CERTIFICATE')) {
      return { tls: null, reason: `${CERT_FILE} is not a PEM certificate.` }
    }
    if (!key.includes('PRIVATE KEY')) {
      return { tls: null, reason: `${KEY_FILE} is not a PEM private key.` }
    }
    const caPath = join(dataDir, 'chain.pem')
    return {
      tls: { cert, key, ...(existsSync(caPath) ? { ca: readFileSync(caPath) } : {}) },
    }
  } catch (error) {
    // Nearly always the key being root-owned after a certbot run.
    return { tls: null, reason: `Could not read the certificate: ${String(error)}` }
  }
}
