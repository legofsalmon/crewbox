// Reading a LiveKit release: which asset this platform wants, and what it
// should hash to.
//
// Split out of fetch-livekit.mjs so it can be tested. The script itself
// fetches, extracts and renames — none of which a unit test should do — but
// these three decisions are the ones that go wrong quietly: the wrong
// architecture's archive, or no check at all on a binary that ends up inside
// something a festival runs as its comms server.

/** LiveKit's asset naming, e.g. livekit_1.9.0_linux_amd64.tar.gz */
export function assetFor(assets, platform, arch) {
  const wanted = `${platform}_${arch}`
  return assets.find((a) => a.name.includes(wanted) && /\.(tar\.gz|zip)$/.test(a.name)) ?? null
}

/**
 * The release asset carrying checksums, if there is one.
 *
 * goreleaser — which is what LiveKit publishes with — emits
 * `livekit_<version>_checksums.txt`, but that name has moved between
 * projects and could move again, so this recognises the shapes rather than
 * one literal.
 */
export function findChecksumAsset(assets) {
  return (
    assets.find((a) => /(^|[_.-])checksums?\.txt$/i.test(a.name)) ??
    assets.find((a) => /^sha256sums?(\.txt)?$/i.test(a.name)) ??
    null
  )
}

/**
 * The digest a checksums file lists for one file.
 *
 * sha256sum's format: `<64 hex>  <name>`, one per line, the name sometimes
 * prefixed with `*` for binary mode. Returns null rather than throwing, so
 * the caller decides what a missing line means.
 */
export function digestFor(text, name) {
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line)
    if (m && m[2] === name) return m[1].toLowerCase()
  }
  return null
}
