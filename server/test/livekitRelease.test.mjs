import { describe, expect, it } from 'vitest'
import { assetFor, digestFor, findChecksumAsset } from '../../scripts/livekit-release.mjs'

/**
 * Which SFU a release build embeds, and whether it checks what it got.
 *
 * The Node base binary a box is built on is verified against nodejs.org's
 * published checksums. The SFU that ships beside it, inside the same binary,
 * was fetched over the internet and embedded unchecked — in something a
 * festival then runs as its comms server. These are the three decisions
 * `fetch-livekit.mjs` makes before that happens.
 */

const assets = (...names) => names.map((name) => ({ name }))

describe('picking the archive for this platform', () => {
  const release = assets(
    'livekit_1.9.0_linux_amd64.tar.gz',
    'livekit_1.9.0_linux_arm64.tar.gz',
    'livekit_1.9.0_windows_amd64.zip',
    'livekit_1.9.0_checksums.txt',
    'livekit_1.9.0_linux_amd64.tar.gz.sbom.json'
  )

  it('matches platform and architecture together', () => {
    expect(assetFor(release, 'linux', 'amd64')?.name).toBe('livekit_1.9.0_linux_amd64.tar.gz')
    expect(assetFor(release, 'linux', 'arm64')?.name).toBe('livekit_1.9.0_linux_arm64.tar.gz')
    expect(assetFor(release, 'windows', 'amd64')?.name).toBe('livekit_1.9.0_windows_amd64.zip')
  })

  it('takes an archive and not something that merely mentions one', () => {
    // The sbom's name contains the archive's name in full. Requiring the
    // extension is what keeps a JSON document out of the box.
    expect(assetFor(release, 'linux', 'amd64')?.name).not.toContain('sbom')
  })

  it('says nothing rather than guessing when the build is not published', () => {
    // macOS, which upstream distributes through Homebrew. The script
    // compiles from source there; what it must not do is pick some other
    // platform's archive.
    expect(assetFor(release, 'darwin', 'arm64')).toBeNull()
  })
})

describe('finding the checksums file', () => {
  it('recognises what goreleaser emits', () => {
    expect(findChecksumAsset(assets('a.tar.gz', 'livekit_1.9.0_checksums.txt'))?.name).toBe(
      'livekit_1.9.0_checksums.txt'
    )
    expect(findChecksumAsset(assets('checksums.txt'))?.name).toBe('checksums.txt')
    expect(findChecksumAsset(assets('SHA256SUMS'))?.name).toBe('SHA256SUMS')
    expect(findChecksumAsset(assets('sha256sums.txt'))?.name).toBe('sha256sums.txt')
  })

  it('is not fooled by an archive whose name happens to contain the word', () => {
    expect(findChecksumAsset(assets('livekit_checksums_linux_amd64.tar.gz'))).toBeNull()
  })

  it('returns null when a release publishes none, so the build can stop', () => {
    // Which is what it does. Embedding a binary nothing checked, in
    // something a crew runs as their comms server, is not a thing to notice
    // afterwards.
    expect(findChecksumAsset(assets('livekit_1.9.0_linux_amd64.tar.gz'))).toBeNull()
  })
})

describe('reading a digest out of a checksums file', () => {
  const A = 'a'.repeat(64)
  const B = 'b'.repeat(64)
  const text = `${A}  livekit_1.9.0_linux_amd64.tar.gz\n${B} *livekit_1.9.0_windows_amd64.zip\n`

  it('finds the line for the file being downloaded', () => {
    expect(digestFor(text, 'livekit_1.9.0_linux_amd64.tar.gz')).toBe(A)
  })

  it('handles the binary-mode asterisk sha256sum writes', () => {
    expect(digestFor(text, 'livekit_1.9.0_windows_amd64.zip')).toBe(B)
  })

  it('matches the whole name, not a prefix of it', () => {
    // `livekit_1.9.0_linux_amd64.tar.gz.sig` must not take the archive's
    // digest, and the archive must not take a longer name's.
    expect(digestFor(text, 'livekit_1.9.0_linux_amd64.tar')).toBeNull()
    expect(digestFor(text, 'amd64.tar.gz')).toBeNull()
  })

  it('returns null for a file the manifest does not list', () => {
    expect(digestFor(text, 'livekit_1.9.0_linux_arm64.tar.gz')).toBeNull()
  })

  it('ignores the headers and blank lines a manifest can carry', () => {
    const noisy = `# livekit 1.9.0\n\n${A}  one.tar.gz\n`
    expect(digestFor(noisy, 'one.tar.gz')).toBe(A)
    expect(digestFor(noisy, '# livekit 1.9.0')).toBeNull()
  })
})
