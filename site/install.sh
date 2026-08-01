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

command -v curl >/dev/null 2>&1 || die "curl is required"

# --- Which version?
# Asset filenames carry the version (crewbox-linux-x64-v0.9.5) so a download
# on disk says what it is. That means "latest" has to be resolved to a tag
# first: the releases/latest page redirects to releases/tag/<version>, and
# the version names the asset exactly. No GitHub API call — the API is
# rate-limited per IP, and a festival's crew all NAT out of one address.
tag="$(curl -fsSL -o /dev/null -w '%{url_effective}' \
  "https://github.com/$REPO/releases/latest" 2>/dev/null | sed -n 's|.*/tag/||p')" || true
[ -n "$tag" ] || die "could not find the latest release of $REPO — is github.com reachable?"

asset="crewbox-$plat-$cpu-$tag"

url="https://github.com/$REPO/releases/download/$tag/$asset"
target="$INSTALL_DIR/crewbox"

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

# Linux gets a launcher entry and a systemd user unit rather than a tray icon.
#
# There is no tray that works everywhere: the modern route is StatusNotifierItem
# over D-Bus, and GNOME — a large share of desktop Linux — shows nothing without
# a third-party extension. An icon that is invisible on GNOME would be worse
# than none, because you would conclude the box wasn't running.
#
# So: the launcher entry opens a terminal, which is idiomatic here and gives you
# the banner, the QR and Ctrl-C. The systemd unit is for the case that actually
# describes most Linux boxes — a machine in a shed with nothing plugged into it.
if [ "$plat" = "linux" ]; then
  apps="$HOME/.local/share/applications"
  units="$HOME/.config/systemd/user"
  mkdir -p "$apps" "$units" 2>/dev/null || true

  cat > "$apps/crewbox.desktop" 2>/dev/null <<EOF || true
[Desktop Entry]
Type=Application
Name=Crewbox
Comment=Crew comms for this event — chat, voice, patch sheets
Exec=$target
Icon=crewbox
Terminal=true
Categories=Network;Chat;
Actions=Stop;

[Desktop Action Stop]
Name=Stop Crewbox
Exec=$target --stop
EOF

  cat > "$units/crewbox.service" 2>/dev/null <<EOF || true
[Unit]
Description=Crewbox — crew comms for this event
After=network-online.target

[Service]
ExecStart=$target
# The box opens a browser on first run, which is wrong for a service.
Environment=CREWBOX_NO_OPEN=1
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

  # Best-effort: a headless box has no desktop database to update.
  command -v update-desktop-database >/dev/null 2>&1 &&
    update-desktop-database "$apps" 2>/dev/null || true
  command -v systemctl >/dev/null 2>&1 &&
    systemctl --user daemon-reload 2>/dev/null || true
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
say ""
say "  Stop it with Ctrl-C, or from anywhere with:  $target --stop"
say "  Check on it any time with:                   $target --status"
if [ "$plat" = "linux" ]; then
  say ""
  say "  Added a Crewbox launcher entry. For a box that stays up on its own:"
  say "    systemctl --user enable --now crewbox"
fi
say ""

exec "$target"
