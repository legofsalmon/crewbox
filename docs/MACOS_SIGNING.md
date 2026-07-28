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

Enrolling as an **Individual** is enough; Organization needs a D-U-N-S number
and takes longer. The Apple ID needs two-factor turned on.

**You need a Mac for the certificate steps** — they go through Keychain
Access.

1. A **Developer ID Application** certificate. In Xcode:
   _Settings → Accounts → Manage Certificates → + → Developer ID Application_.
   Without Xcode: generate a CSR in Keychain Access (_Certificate Assistant →
   Request a Certificate From a Certificate Authority_, save to disk) and
   upload it at <https://developer.apple.com/account> → Certificates → +.

   It must be **Developer ID Application**. "Apple Development" signs for your
   own machines and "Mac App Distribution" signs for the App Store; neither
   works for an app someone downloads.

2. Export it from Keychain Access as a `.p12` with a password. Right-click the
   **certificate** row, not the private key nested under it — the certificate
   row carries both, and exporting the key alone produces a `.p12` that fails
   to sign.

## The secrets

Six, added under _Settings → Secrets and variables → Actions_ in the crewbox
repo. Each one below says exactly what the value looks like, because most of
these fail in CI with an error that doesn't name the real cause.

### `MAC_SIGN_IDENTITY`

```sh
security find-identity -v -p codesigning
```

```
  1) 8A3F2C1D9B7E5A4F6C2D8B1E3A7F9C5D2B4E6A8F "Developer ID Application: Your Name (AB12CD34EF)"
     1 valid identities found
```

The secret is the quoted part **without the quotes** — not the hex hash:

```
Developer ID Application: Your Name (AB12CD34EF)
```

Nothing printed means the certificate isn't in the keychain yet.

### `MAC_SIGN_CERT_P12`

```sh
base64 -i cert.p12 | tr -d '\n' | pbcopy
```

`tr -d '\n'` is not optional — a wrapped value fails to decode on the runner.

### `MAC_SIGN_CERT_PASSWORD`

The password typed into the Export dialog. Not the Mac login password, not the
Apple ID password.

### `MAC_NOTARY_APPLE_ID`

The email address of the Apple ID enrolled in the Developer Program.

### `MAC_NOTARY_PASSWORD`

An **app-specific password**: <https://appleid.apple.com> → Sign-In and
Security → App-Specific Passwords → +. Comes out as `abcd-efgh-ijkl-mnop`;
keep the hyphens, and copy it straight away because Apple shows it once. A
real Apple ID password is rejected here.

### `MAC_NOTARY_TEAM_ID`

Ten alphanumeric characters, at <https://developer.apple.com/account> →
Membership details. It is also the string in parentheses at the end of
`MAC_SIGN_IDENTITY` — if those two disagree, one of them is wrong.

## Check them without cutting a release

Once the six are set, run **Actions → Check macOS signing → Run workflow**.

It imports the certificate, signs a throwaway binary with it, and asks Apple
to accept the notary credentials — about ninety seconds, and it builds and
publishes nothing. Worth doing before a release rather than after, because
each of these fails in a way that doesn't name its own cause, and the
silent one is the worst: a **misspelled secret name** doesn't fail at all.
The release just skips signing and ships an unsigned `.dmg`.

It also catches the mismatch that survives a green release — a
`MAC_NOTARY_TEAM_ID` that isn't the team in `MAC_SIGN_IDENTITY` notarises
under one team and signs under another, and Gatekeeper still refuses the
download.

## Check the .p12 before uploading it

Two commands that catch the two mistakes actually worth catching:

```sh
# Is the password right, and does the identity match what you'll paste?
openssl pkcs12 -in cert.p12 -passin pass:'YOURPASSWORD' -nokeys | openssl x509 -noout -subject

# Is the private key in there at all?
openssl pkcs12 -in cert.p12 -passin pass:'YOURPASSWORD' -nocerts -noout && echo "private key present"
```

The first prints a subject containing `CN=Developer ID Application: …`, which
should equal `MAC_SIGN_IDENTITY` exactly. If the second errors, the export
picked up the certificate without its private key — the usual cause is
right-clicking the key row rather than the certificate row in Keychain Access.
That one fails in CI as an opaque keychain error, well after the point where
it is obvious what happened.

Put a space before those commands if your shell keeps history; the password is
on the line.

## What happens then

The next release signs the app with a hardened runtime, notarises **the app**
and staples its ticket, then builds the `.dmg` around that stapled app and
notarises and staples the image too.

Both, in that order, and it matters. Stapling only the disk image looks right
in a build log and leaves the app someone drags to /Applications carrying no
ticket at all — which sends Gatekeeper to ask Apple on first launch. A crew
box is routinely set up on a network that cannot reach Apple, a shed at a
festival site with no uplink, and that is exactly where an un-stapled app is
refused.

Two round trips to Apple rather than one, so a few more minutes per release.
The first submission on a new account is usually the slowest. These are the
only steps that talk to Apple.

To confirm it took, download the `.dmg` on a Mac that has never seen it —
quarantine is only applied to downloaded files, so a copy moved over by USB
proves nothing — then run **both** of these on the installed app:

```sh
spctl -a -vv /Applications/Crewbox.app       # is it accepted?
xcrun stapler validate /Applications/Crewbox.app   # is the ticket *in* it?
```

`accepted` with `source=Notarized Developer ID` from the first, and
`The validate action worked!` from the second.

**Run the second one.** `spctl` will happily say `accepted` for an app with no
stapled ticket, because it can ask Apple over the internet — which is exactly
the thing a crew box cannot do. `stapler validate` is the only check that
proves the ticket travelled inside the file, and that is what makes the app
open in a shed with no uplink. A v0.7.0 build passed `spctl` and failed
`stapler validate`: the release had stapled the disk image but never the app
dragged out of it.

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
