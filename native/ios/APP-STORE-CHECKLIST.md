# iOS App Store submission checklist

What the code already handles vs. the manual steps you do in Xcode and App Store
Connect. Bundle id: `com.colmhewson.crewbox`. Target: iPhone only.

## Done in the codebase (no action needed)

- [x] **In-app account deletion** — required by Apple guideline 5.1.1(v).
  Sidebar → *Delete account*, typed-name confirmation, server wipes the account.
- [x] **Export compliance** — `ITSAppUsesNonExemptEncryption = false` in
  `Info.plist` (only standard TLS is used), so no per-build encryption prompt.
- [x] **Permission strings** — microphone and local-network usage descriptions
  are set in `Info.plist`.
- [x] **iPhone-only target** — `TARGETED_DEVICE_FAMILY = 1`, so you only need
  iPhone screenshots, not iPad.
- [x] **Privacy policy** — `docs/privacy-policy.html` (host it, see below).

## Before you archive (Xcode)

1. Open `native/ios/App/App.xcodeproj`.
2. Signing & Capabilities → set your **Team**; let Xcode manage signing.
3. Bump **Version** (`MARKETING_VERSION`) and **Build** (`CURRENT_PROJECT_VERSION`)
   for each upload.
4. **Rebuild the web bundle into the shell first** — the app ships whatever is in
   `web/dist`: `npm --prefix web run build && npx --prefix native cap sync ios`.
5. Product → Archive → Distribute App → App Store Connect.

## Host the privacy policy (need a public URL)

- Repo Settings → Pages → deploy from `main` / `/docs`. That serves
  `https://legofsalmon.github.io/crewbox/privacy-policy.html`.
- Edit `docs/privacy-policy.html`: replace **[YOUR SUPPORT EMAIL]** with a real
  contact address before publishing.

## In App Store Connect (manual)

1. **Create the app** — name, primary language, bundle id, SKU.
2. **Privacy Policy URL** — the Pages URL above (required).
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
