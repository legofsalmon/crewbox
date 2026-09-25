# iOS App Store submission checklist

What the code already handles vs. the manual steps you do in Xcode and App Store
Connect. Bundle id: `com.colmhewson.crewbox`. Target: iPhone only.

## Done in the codebase (no action needed)

- [x] **In-app account deletion** — required by Apple guideline 5.1.1(v).
  Sidebar → *Delete account*, typed-name confirmation, server wipes the account.
- [x] **Export compliance** — `ITSAppUsesNonExemptEncryption = false` in
  `Info.plist` (only standard TLS is used), so no per-build encryption prompt.
- [x] **Permission strings** — microphone, local-network, camera and
  save-to-Photos usage descriptions are set in `Info.plist`, and
  `server/test/iosInfoPlist.test.mjs` fails if one goes missing. iOS
  terminates an app that uses one of these without its string.
- [x] **Wi-Fi entitlements** — `App/App.entitlements` asks for Hotspot
  Configuration, to join the Wi-Fi from its QR code, and Access Wi-Fi
  Information, to check the phone got on it. Both configurations of the
  target sign with it, and `server/test/iosInfoPlist.test.mjs` fails if
  either goes. Neither needs Apple's approval or a purpose string, but both
  need the paid Apple Developer Program, as the App Store does. Joining
  doesn't work in the Simulator, so try it on a phone.
- [x] **iPhone-only target** — `TARGETED_DEVICE_FAMILY = 1`, so you only need
  iPhone screenshots, not iPad.
- [x] **iOS 17 and later** — `IPHONEOS_DEPLOYMENT_TARGET = 17.0` in every
  configuration: iPhone XS and newer. The planned native features need iOS
  16.1 to 16.4, and there are no installs on older versions to strand.
- [x] **Privacy policy** — `site/docs/privacy-policy.html` (deployed at https://crewbox.letissier.ie/docs/privacy-policy).
- [x] **No App Transport Security justification needed** — the one exemption
  set is `NSAllowsLocalNetworking`, which is not on Apple's list of keys that
  need one. It lets the app use plain HTTP to IP addresses, `.local` names and
  one-word names, which is how a box without a certificate is reached.
  `server/test/iosInfoPlist.test.mjs` fails if either key that does need a
  justification appears (see the decision below).

## Decided, and yours to overturn: no plain HTTP to other names

`NSAllowsArbitraryLoadsInWebContent` would let the web view, which is the
whole app, use plain HTTP to any name, so a box without a certificate could be
reached as `crewbox.lan` as well as by its IP address. It is left off:

- A box only advertises a name when it has a certificate for it, so nothing
  the box prints leads an iPhone to a plain-HTTP name.
- An iPhone user who types one is told at once to use the IP address, or
  `https://` if the box has a certificate, rather than left on "can't reach".
- It switches App Transport Security off for everything the web view loads,
  and App Review asks for a justification. (`NSAllowsArbitraryLoads` is off
  too: iOS 10 and later ignore it beside `NSAllowsLocalNetworking`, but it
  still asks for one.)

If venues turn out to reach plain-HTTP boxes by name, turning it on means:
the key set to `true` in `Info.plist`, the test that forbids it changed,
`iphoneRefusesPlainHttp` in `web/src/lib/server.ts` made to return false, and
a justification at submission, along the lines of "the app connects to a
server the event organiser runs on the event's own network, reached by a local
name and usually without a certificate".

## Before you archive (Xcode)

1. Open `native/ios/App/App.xcodeproj`.
2. Signing & Capabilities → set your **Team**; let Xcode manage signing.
   It lists **Hotspot Configuration** and **Access Wi-Fi Information** there,
   from the entitlements file, and switches them on for the App ID. Signing
   by hand instead, switch both on for `com.colmhewson.crewbox` under
   Certificates, Identifiers & Profiles and make a new profile, or the
   archive won't sign.
   It lists **App Groups** too, with `group.com.colmhewson.crewbox`, where the
   sign-ins are kept so the lock-screen alerts can read them; let it register
   the group, or register it under Identifiers → App Groups and switch it on
   for the App ID. The name is fixed once it ships.
   Set the same Team on the **Countdown** target, the lock screen's stage
   countdown. Its bundle id is `com.colmhewson.crewbox.countdown`, and it
   needs no capabilities of its own.
3. Bump **Version** (`MARKETING_VERSION`) and **Build** (`CURRENT_PROJECT_VERSION`)
   for each upload, on both the App and the Countdown targets. App Store
   Connect refuses an upload whose extension's version differs from the
   app's, and `server/test/iosInfoPlist.test.mjs` fails first.
4. **Rebuild the web bundle into the shell first** — the app ships whatever is in
   `web/dist`: `npm --prefix web run build && npx --prefix native cap sync ios`.
5. Product → Archive → Distribute App → App Store Connect.

## The privacy policy's public URL

- The docs site deploys to Vercel from `site/` (see `site/README.md`), and
  serves the policy at `https://crewbox.letissier.ie/docs/privacy-policy` with
  the rest of the docs. There is nothing separate to host.
- Edit `site/docs/privacy-policy.html`: replace **[YOUR SUPPORT EMAIL]** with a
  real contact address before submitting. App Review opens the policy.

## In App Store Connect (manual)

1. **Create the app** — name, primary language, bundle id, SKU.
2. **Privacy Policy URL** — the URL above (required).
3. **App Privacy questionnaire** — answer to match the policy:
   - Data collected: *Name* and *User Content* (messages), linked to the user,
     used only for **App Functionality**. No tracking, no third-party sharing,
     no analytics/ads. (Data lives on the organizer's server, not yours — but
     Apple still wants it declared as collected.)
4. **Age rating** — questionnaire; unrestricted messaging means likely **17+**
   (user-generated content), answer honestly.
5. **Screenshots** — 6.7" and 6.5" iPhone required. Use the Simulator:
   run the app, `Cmd+S` to save screenshots of the join screen, a channel with
   messages, voice, and the file view.
6. **Description / keywords / support URL / promotional text.**
7. **Sign-in for review (critical)** — App Review can't reach a festival LAN, so
   in *App Review Information* give them either:
   - a **demo server URL** reachable over the internet (spin up the Cloudflare
     tunnel — see `deploy/RUNBOOK.md` — and set `EVENT_PIN`), plus a demo name
     and event PIN, **or**
   - clear notes that the app needs an organizer-run server, with the demo
     server details. Without this the build is rejected as "can't review".
8. **Submit for review.**

## First-submission gotchas (from Apple's common rejections)

- **Reachable demo** — the #1 rejection risk here; the reviewer must be able to
  join and see the app work. The tunnel demo server covers this.
- **Account deletion must be reachable in review** — it is (sidebar link);
  point the reviewer to it if they ask.
- **Guideline 4.2 (minimum functionality)** — a chat app is fine, but the demo
  server must have some seed content so it doesn't look empty.
