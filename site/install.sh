#!/bin/sh
# Crewbox installer.
#
#   curl -fsSL https://crewbox.letissier.ie/install.sh | sh
#
# Downloads the latest box for this machine, clears the quarantine flag that
# would otherwise make macOS refuse to run it, and starts it. Nothing else to
# install — the box carries the web app and the voice server inside it.
#
# POSIX sh on purpose: this has to run on a stage laptop, a rented Mac mini,
# and whatever Linux box the production office had spare.
#
# Binaries come from the public crewbox-dist repo, not from the source repo,
# which stays private. Release builds push them there; see
# .github/workflows/release.yml.
set -eu

# The one place the distribution repo is named.
REPO="${CREWBOX_DIST_REPO:-legofsalmon/crewbox-dist}"
INSTALL_DIR="${CREWBOX_INSTALL_DIR:-$HOME/.crewbox/bin}"

say() { printf '%s\n' "$*"; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

# --- Which build?
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
Darwin) plat="darwin" ;;
Linux) plat="linux" ;;
*) die "no build for $os. Windows: download the .exe from https://crewbox.letissier.ie" ;;
esac
case "$arch" in
x86_64 | amd64) cpu="x64" ;;
arm64 | aarch64) cpu="arm64" ;;
*) die "no build for $arch" ;;
esac

asset="crewbox-$plat-$cpu"
# Only Apple Silicon gets a macOS build today; Intel Macs run the x64 one
# under Rosetta, which works but is worth saying out loud.
if [ "$plat" = "darwin" ] && [ "$cpu" = "x64" ]; then
  asset="crewbox-darwin-arm64"
  say "note: no Intel Mac build — using the Apple Silicon one under Rosetta."
fi

url="https://github.com/$REPO/releases/latest/download/$asset"
target="$INSTALL_DIR/crewbox"

command -v curl >/dev/null 2>&1 || die "curl is required"

say ""
say "  Crewbox"
say "  Downloading $asset (about 120 MB — it carries everything)…"
say ""

mkdir -p "$INSTALL_DIR"
tmp="$target.download"
# --fail so an HTML error page never lands here pretending to be a binary.
curl -fL --progress-bar -o "$tmp" "$url" || die "download failed: $url"
chmod +x "$tmp"
mv -f "$tmp" "$target"

# macOS quarantines anything downloaded, and an unsigned quarantined binary
# is refused outright with a dialog that offers no way forward. Clearing the
# attribute here is what turns "right-click, Open, Cancel, google it" into
# "it just ran". Best-effort: xattr is absent on some minimal systems.
if [ "$plat" = "darwin" ]; then
  xattr -d com.apple.quarantine "$target" 2>/dev/null || true
fi

say ""
say "  Installed to $target"
say ""

# A login shell will find it next time; this run needs no PATH changes.
case ":${PATH}:" in
*":$INSTALL_DIR:"*) ;;
*) say "  Add it to your PATH with:  export PATH=\"\$PATH:$INSTALL_DIR\"" ;;
esac

say "  Starting the box — it will print a QR for crew to scan."
say "  Stop it with Ctrl-C; run it again any time with:  $target"
say ""

exec "$target"
