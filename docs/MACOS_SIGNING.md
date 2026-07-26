# Signing and notarising the macOS app

The release workflow already builds `Crewbox.dmg` on every run. It is a
working disk image today, but an **unsigned** one, so macOS quarantines it
and refuses to open it with a dialog that offers no way forward.

This page is the one-time setup that turns it into "download, double-click,
done". Nothing here changes the code — it is six secrets.

## Why bother

Gatekeeper refuses _any_ unsigned downloaded app: a bare binary, a `.app`, a
`.dmg`, a `.pkg`. Packaging cannot route around it. The one-line installer
works today only because it runs `xattr -d com.apple.quarantine` for you,
which is why it currently gives a better experience than a disk image would.

Signing plus notarisation is the only route that removes the friction rather
than working around it. It also lets one file serve both Intel and Apple
Silicon Macs, so nobody has to know which machine they own.

## What you need

**Apple Developer Program membership — $99/year.** There is no free tier for
notarisation. Enrol at <https://developer.apple.com/programs/>.

From that account:

1. A **Developer ID Application** certificate. In Xcode:
   _Settings → Accounts → Manage Certificates → + → Developer ID Application_.
   Not "Apple Development" and not "Mac App Distribution" — those sign for
   the App Store and for your own machines, neither of which is this.
2. Export it from Keychain Access as a `.p12` with a password. Export the
   **certificate together with its private key** — right-click the
   certificate, not the key.
3. An **app-specific password** for notarisation, from
   <https://appleid.apple.com> → Sign-In and Security → App-Specific
   Passwords. Your real Apple ID password will not work.
4. Your **Team ID**, the ten-character string at
   <https://developer.apple.com/account> → Membership.

## The secrets

Add these under _Settings → Secrets and variables → Actions_ in the crewbox
repo:

| Secret                   | Value                                                            |
| ------------------------ | ---------------------------------------------------------------- |
| `MAC_SIGN_CERT_P12`      | The `.p12`, base64 encoded: `base64 -i cert.p12 \| pbcopy`       |
| `MAC_SIGN_CERT_PASSWORD` | The password you set when exporting the `.p12`                   |
| `MAC_SIGN_IDENTITY`      | `Developer ID Application: Your Name (TEAMID)` — copy it exactly |
| `MAC_NOTARY_APPLE_ID`    | The Apple ID email on the developer account                      |
| `MAC_NOTARY_PASSWORD`    | The app-specific password from step 3                            |
| `MAC_NOTARY_TEAM_ID`     | The ten-character Team ID                                        |

`security find-identity -v -p codesigning` prints `MAC_SIGN_IDENTITY` in the
exact form codesign wants, once the certificate is in your keychain.

## What happens then

The next release signs the app with a hardened runtime, wraps it in a `.dmg`,
submits that to Apple's notary service, waits for the result, and **staples**
the ticket into the image.

Stapling is the part that matters for this product: it writes the
notarisation ticket into the file, so Gatekeeper can clear it without asking
Apple. A crew box is often set up on a network that cannot reach Apple at
all — a shed at a festival site with no uplink — and an un-stapled app gets
refused exactly there.

Notarisation adds a few minutes to the release. It is the only step that
talks to Apple.

## Until then

Everything works without any of this. The `.dmg` still builds and still
contains a universal app; it just needs the same right-click → Open dance as
the bare binary, so the one-line installer remains the better path. The
workflow skips signing and notarisation cleanly when the secrets are absent
rather than failing the release.

## Windows

The same problem exists there — SmartScreen warns about any unsigned
executable — and the same fix applies, but the economics are worse. An OV
code-signing certificate runs a few hundred a year and still shows the
warning until the binary builds download reputation; an EV certificate skips
the reputation wait but costs more again and usually needs a hardware token,
which does not fit an unattended CI runner. The Windows warning is documented
in QUICKSTART instead.
