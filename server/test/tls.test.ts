import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CERT_FILE, KEY_FILE, loadTls } from '../src/tls.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'crewbox-tls-'))
  dirs.push(dir)
  return dir
}

/** A throwaway self-signed pair, as certbot would leave behind. */
export const makeCert = (dir: string) => {
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(dir, KEY_FILE),
      '-out',
      join(dir, CERT_FILE),
      '-days',
      '1',
      '-subj',
      '/CN=box.test',
    ],
    { stdio: 'ignore' }
  )
}

describe('loading TLS material', () => {
  it('finds a certificate pair in the data directory', () => {
    const dir = tempDir()
    makeCert(dir)

    const { tls, reason } = loadTls(dir)
    expect(reason).toBeUndefined()
    expect(tls?.cert.toString()).toContain('BEGIN CERTIFICATE')
    expect(tls?.key.toString()).toContain('PRIVATE KEY')
  })

  it('is silent when there is no certificate at all', () => {
    // Not an error: most boxes run on plain HTTP and that's a working product.
    const { tls, reason } = loadTls(tempDir())
    expect(tls).toBeNull()
    expect(reason).toBeUndefined()
  })

  it('explains a half-configured pair rather than ignoring it', () => {
    // Copying one file and forgetting the other is the common mistake, and
    // silently serving HTTP would leave the admin wondering why.
    const dir = tempDir()
    makeCert(dir)
    rmSync(join(dir, KEY_FILE))

    const { tls, reason } = loadTls(dir)
    expect(tls).toBeNull()
    expect(reason).toContain(KEY_FILE)
  })

  it('rejects files that are not actually PEM', () => {
    const dir = tempDir()
    writeFileSync(join(dir, CERT_FILE), 'not a certificate')
    writeFileSync(join(dir, KEY_FILE), 'not a key')

    const { tls, reason } = loadTls(dir)
    expect(tls).toBeNull()
    expect(reason).toContain('not a PEM certificate')
  })

  it('picks up a separate chain when the deployment supplies one', () => {
    const dir = tempDir()
    makeCert(dir)
    writeFileSync(join(dir, 'chain.pem'), '-----BEGIN CERTIFICATE-----\nchain\n')

    expect(loadTls(dir).tls?.ca?.toString()).toContain('chain')
  })
})
