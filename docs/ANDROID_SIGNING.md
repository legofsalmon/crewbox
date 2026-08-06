# Android release signing

Android only installs an update **over** an existing app when the new APK is
signed with the **same key** as the old one. Until these secrets exist, the
release workflow falls back to a debug build whose key is minted fresh on
every CI runner — so each release has a different signature, and a phone with
an earlier crewbox installed refuses the new one. The crew member has to
uninstall first, which also deletes the app's local data.

One persistent keystore fixes that permanently. Set it up once:

## 1. Mint the keystore (once, on your own machine)

```bash
keytool -genkeypair -v \
  -keystore crewbox-release.keystore \
  -alias crewbox \
  -keyalg RSA -keysize 4096 \
  -validity 10000
```

Answer the prompts (the name fields can just say Crewbox). Pick a strong
store password; reuse it for the key password when asked.

## 2. Put it in the repo's Actions secrets

Repo **Settings → Secrets and variables → Actions → New repository secret**,
four of them:

| Secret                      | Value                                           |
| --------------------------- | ----------------------------------------------- |
| `ANDROID_KEYSTORE_BASE64`   | `base64 -i crewbox-release.keystore` (one line) |
| `ANDROID_KEYSTORE_PASSWORD` | the store password                              |
| `ANDROID_KEY_ALIAS`         | `crewbox`                                       |
| `ANDROID_KEY_PASSWORD`      | the key password                                |

The next release builds a properly signed `assembleRelease` APK; nothing else
changes.

## 3. Keep the keystore forever

Back the `.keystore` file and its passwords up somewhere that survives your
laptop — a password manager attachment is fine. **If the key is lost, every
phone in the field must uninstall/reinstall once more** to accept an APK
signed with its replacement, exactly the break this setup ends. Never commit
the keystore to the repo (it's a public repo; the `.keystore` pattern is
ignored, but don't rely on that).

## The one-time break

The first release signed with the real key is itself an upgrade break for
phones that installed a debug-signed release — their signature can't match.
That's unavoidable and worth doing early: today _every_ release is that
break; after this, none are. Version codes now also rise with the release
version (`v0.10.1` → `versionCode 1001`), which Android's updater requires.
