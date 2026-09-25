# Updating a box

_Written against v0.18.0, the first release a box in the field can install by
itself._

A crewbox checks once a day whether a newer release exists, says so in the
tray and the admin panel, and — if an admin asks it to, twice — downloads that
release, proves it came from us, copies its own database, swaps its binary,
restarts, and puts everything back if the new build will not start.

This document is the operator's half: what the box actually does, how to check
a build without trusting any of our code, how to turn the whole thing off, and
what to do when it goes wrong.

## The short version

1. The box asks `api.github.com` once a day what the newest release is.
2. An admin presses **Download**. Nothing is installed.
3. The box fetches `SHA256SUMS-<version>` and its signature **first**, and
   checks that signature against keys compiled into the running binary. Only
   then does it fetch the two hundred megabytes.
4. An admin presses **Install and restart**, reads what that would interrupt,
   and confirms.
5. The database is copied. The binary is swapped. The port is released. The
   new box starts, and the old process watches until it answers.
6. If it never answers, the old binary goes back and the box keeps running.

Steps 1–3 are reversible and nobody notices them. Step 5 is the only part
where the box is off the air, and it lasts about twenty seconds.

Phones follow on their own. A browser loads the new screens from the box, and
the iPhone and Android apps fetch them, check that a release made them, and
offer them with one tap ([Phones follow their box](#phones-follow-their-box)).

## The 1.0.0 reset

Version numbers restarted at **1.0.0** on 24 September 2026, the first release
sold with a licence. Every release before it is `v0.x` (the newest `v0.19.0`),
so ordinary version order still points the right way and nothing special was
needed in the checker:

- A box on any 0.x release is offered 1.0.0 and installs it the normal way.
- A 1.0.0 box asks for `/releases/latest`, compares it numerically, and is
  never offered a 0.x release, even one that is still published.
- Android's `versionCode` is derived from the version (`1.0.0` → `10000`),
  which is above every 0.x code, so phones upgrade in place.

What would break this: publishing a release on `crewbox-dist` numbered above
the current line (say a stray `v1.2.0` left over from testing), or marking an
old 0.x release as "latest" by hand. `/releases/latest` returns whichever
release GitHub considers latest, and a box believes it. Check the release list
before cutting a version, and cut releases only with the **Release** workflow's
`workflow_dispatch` (type `v1.0.0`), never by pushing a tag.

## What the box trusts, and why

Downloading a file off the internet and running it as the box is the most
dangerous thing crewbox does. Everything else it touches it either reads
(lighting, video, the media network) or serves to a crew.

There are two gates and they are **not the same gate**:

- **The digest** says the bytes arrived intact. It comes from the release
  manifest, and on its own it proves nothing about who wrote that manifest.
- **The signature** says the manifest came from somebody holding a crewbox
  release key. That is the one that matters.

The signature is checked against public keys **compiled into the running
binary** — not fetched, not configurable, not in the database. An attacker who
owns the GitHub account can publish whatever they like and no box will run it.

The private half signs releases in CI and exists nowhere else.

### Trust is a set, not a key

`TRUSTED_KEYS` in `server/src/update/verify.ts` is a list.

That is deliberate and it is the whole reason rotation is possible. A box
running v0.18 carries v0.18's idea of what is trusted, for ever. Bake in a
single key and it can never change: rotate, and every box already in the field
rejects every future release — **the updater becomes the one thing that cannot
be updated**.

With a set, a new key ships in release N, boxes pick it up as they update, and
releases move to signing with it once enough of the field has caught up. Old
keys stay listed until nothing that old is still running.

The phone apps carry the same set, compiled into each app, and check a box's
screens against it before they run them
([Phones follow their box](#phones-follow-their-box)). A key reaches a phone
only in an update of the app.

Adding a key to that list is a decision about who may take over every crewbox
in existence, and the app on every crew phone with every event it holds. It
deserves a conversation, not a commit.

## Checking a build yourself

You do not have to trust the box, or this code, to check what you downloaded.

Every release carries `SHA256SUMS-<version>` — plain `sha256sum` output, one
line per asset — and `SHA256SUMS-<version>.sig`, a detached ed25519 signature
over it.

**The bytes:**

```bash
sha256sum -c SHA256SUMS-v1.0.0
```

Every file you downloaded should say `OK`. Files you did not download are
reported as missing, which is fine.

**The signature**, with the public key from `verify.ts`:

```bash
# Save the public key as crewbox-release.pub.pem, then:
openssl pkeyutl -verify \
  -pubin -inkey crewbox-release.pub.pem \
  -rawin -in SHA256SUMS-v1.0.0 \
  -sigfile <(base64 -d SHA256SUMS-v1.0.0.sig)
```

`Signature Verified Successfully` means the manifest came from us. A box does
both of these automatically and refuses anything that fails either.

## What happens during an install

The order is the safety. Every step before the port is released is reversible
without anybody noticing.

**1. The database is copied first.** Migrations are forward-only. Putting an
old binary back in front of a database a newer build has already migrated does
not crash — which would at least be honest. It opens happily, sees a schema
version it does not recognise, runs nothing, and serves a schema it does not
understand: missing columns, absent tables, and a crew wondering why the show
log is empty.

So a rollback is never just "put the old binary back". The copy lands in
`<data dir>/snapshots/crewbox-<version>-<timestamp>.db`, three are kept, and
it is a complete self-contained database — no `-wal` file to forget.

**2. The binary is swapped, not overwritten.** You cannot overwrite a running
executable, but you can rename it. The old one moves to `<name>.old`, the new
one takes its place. At every instant in between there is a complete working
binary on disk under a known name.

**3. Only then is the port released.** And every port, not just the obvious
one: the box terminates every WebSocket (crew phones do not hang up on their
own, and a listener waiting for them to would wait for ever), stops the
mirror on 127.0.0.1 and the captive-portal responder on :80, and stops its
own voice server so the new box finds 7880 free. Then the new process starts.
The wait is bounded — a release that never returned would leave a box with a
swapped binary and no way back, so a timeout is a failure the updater can
roll back from.

**4. The old process watches.** It stays alive, waiting for the new box to
write its status file. This is the arrangement that makes rollback possible at
the moment it is needed: a build that will not start cannot be the thing that
notices it did not start.

**5. If the new box never answers**, within forty-five seconds, the old binary
goes back, the old process starts listening again — with its voice server, its
loopback mirror and its captive responder — and the panel says what happened.
The box is exactly where it was, down to the web client it serves: each
version's bundle is extracted to its own `<data dir>/web-dist/<version>/`, so
a rollback keeps its own, and the verified download is put back under
`<data dir>/updates/` so trying again costs a rename rather than the whole
transfer over the venue's uplink.

**And the database goes back too.** Which half of the rollback does it depends
on where the rollback happens.

If the box has already restarted — a power cut mid-install, or any rollback
finished by a later start — the restore happens there, before anything opens
the database: the copy from step 1 goes back in place and the migrated one is
moved aside to `crewbox.db.superseded-<timestamp>` (with its `-wal` and
`-shm`, so the set stays openable). Nothing is deleted.

If the rollback happens in the running box, it will not touch the database
there: crew are typing into it and that process has it open, so replacing the
file would take whoever is on shift with it. Instead the debt is written to
`<data dir>/restore-db.json` and the panel says to restart the box, which is
what pays it.

Either way it only happens when the failed build actually migrated something.
Most rollbacks are of a build that never got as far as opening the database,
and replacing it there would throw away every message sent since the copy was
taken for no reason at all. The schema number is the test.

### On a Mac, the whole app is replaced

A box running inside `Crewbox.app` cannot be updated by swapping the binary
inside it. That would break the bundle's code signature, and a broken
signature on macOS is not a warning — Gatekeeper refuses to launch the app,
from a double-click that offers no explanation.

So the `.dmg` is mounted, the app inside it is checked with `codesign` and
`spctl`, and the whole bundle is replaced with `ditto`. The installed copy is
then checked **again**, because a copy that damaged the signature would have
passed every check made on the mounted image.

All of that works with no internet, because the release is stapled.

## Phones follow their box

A browser gets a box's new version the way it gets any page: from the box,
the next time it loads. The iPhone and Android apps come with screens of their
own built in, and run their box's instead once they have them and have checked
them. None of this touches the box's own update, and nothing changes on a
phone until somebody taps.

When a phone's box runs another version, after an install or a rollback, the
app:

1. Asks the box for the signed list of its screens, `GET /api/app/screens`.
2. Checks the list's signature against the release keys compiled into the app,
   its own copy of `TRUSTED_KEYS`. The box checks none of it: a check made by
   the thing being checked is no check, so it hands over what it has and the
   phone decides.
3. Reads `crewbox-web.json`, the screens' description of themselves, and
   checks that they are the version the box says it runs, and that this app
   can run them (below).
4. Fetches every other file on the list from the box, checks each against its
   digest as it lands, and keeps the whole set in `crewbox-screens/<version>/`,
   which backups leave out.
5. Offers it: **New version ready — Reload**. One tap switches, and the page
   reloads where it was.

Screens that don't say they have drawn within 20 seconds of loading, with the
app in front, or that take the app down twice as it starts, are dropped on
that phone for good, for that build of the app, and the app goes back to its
own. Each event runs its own box's version and opens on it next time, with
signal or without, so a phone in two events may run a different version in
each.

**What `/api/app/screens` answers.**
`{ "version": "1.0.1+abc1234", "sums": "…", "signature": "…" }`: the version
the box runs, the list `WEBSUMS` exactly as it was signed (one `sha256sum` line
per file), and `WEBSUMS.sig`, the Ed25519 signature over it, in base64. Both
are read from the folder the box serves for its own version, so a box that
rolled back answers with the older version's list, beside the older version's
files, and its phones are offered that version the same way. A box with no
signed screens answers 404: one run from source, a fork, or anybody's own
build. The apps keep their own screens there, and at a box from a release
before releases signed their screens. The route is public, like
`/api/config`, since every file it lists is one the box serves to anybody who
can reach it, and it is never cached.

**What an app will run.** Only screens a crewbox release signed, and only the
version the box says it runs, so a box can't pass one release off as another.
Past that, three numbers decide, and each is raised on purpose:

- The screens' `needs`, in `web/src/lib/nativeApi.ts`, against the app's
  `NATIVE_API`. Screens that need more of the app's native code than it has
  wait for the app to be updated.
- The screens' `builtFor` against the app's `OLDEST_SCREENS_API`, the oldest
  contract it still keeps. Screens older than that wait for the box to be
  updated.
- The version against the app's floor, `FLOOR` in `Screens.java` and `floor`
  in `ScreensPlugin.swift`: the oldest screens it runs at all. A release that
  fixes a hole in the screens raises the floor in both apps, so that no box
  can hand a phone the hole again. That reaches a phone only when its app is
  updated.

A phone that can't run its box's version carries on with the one it has. A
note says to update the app whenever that is the fix, and to update the box
when the phone's screens can't talk to it. An app also refuses a set of over
500 files or 50 MB, the limits `scripts/sign-web.mjs` won't sign past, and
needs that much room free before it fetches one. The screens are a few
megabytes, and each phone fetches each version once, from the box and never
from the internet.

**The app still needs its own updates**: for anything new in its native code,
a new release key, a raised floor, or screens that need a newer app. An iPhone
gets them from the App Store, and an Android phone from the release's APK once
it is in the box's data directory, where `/connect` offers it.

## Recovering by hand

**The new box will not start and the rollback failed.** The old binary is at
`<name>.old` beside it. Rename it back and start it.

**The database is wrong after a rollback.** Restart the box first — if the
rollback happened in the running process it left the restore owed, and the
next start does it. If that is not it, snapshots are in
`<data dir>/snapshots/`, newest first, named with the version they belong to.
Stop the box, copy the one matching your binary's version over
`<data dir>/crewbox.db`, and start it. Delete any `crewbox.db-wal` and
`crewbox.db-shm` beside it first.

**Getting back what the failed build wrote.** A restore never deletes: the
database it replaced is beside the live one as
`crewbox.db.superseded-<timestamp>`. It is a normal SQLite file and can be
opened with any tool, which is the way to recover anything sent in the minutes
the new build was up.

**An update was interrupted by a power cut.** Nothing to do. On the next start
the box reads its own marker, compares it against the version it is actually
running, and either keeps the new build (it is plainly working) or finishes
putting the old one back. A version matching neither is left alone and said
out loud in the log, because a box nobody can reason about is one to leave
alone.

**The box is on a network that must make no outbound connections.** See below.

## Turning it off

`CREWBOX_UPDATE_CHECK=0` stops the daily question. The box then never contacts
GitHub, the tray never mentions an update, and the panel shows nothing.

The default is on for a packaged box and off when running from source. A box
run from source cannot install anything anyway — there is no binary to swap —
and says so rather than offering a button that could only ever fail.

Nothing is ever downloaded or installed without an admin pressing two separate
buttons. Turning the check off is about the outbound connection, not about
safety.

## What the outbound check sends

One HTTPS GET a day, to `api.github.com`, for the newest release of the public
`crewbox-dist` repository. It carries this box's IP address (as any request
does) and a `crewbox` user agent, and nothing else — no event name, no crew,
no version history, no identifier. The reply is a release number and a URL.

A failed check is not an error. Most festival boxes have no internet for days,
and a box told about v0.18 on the Thursday still says so on the Saturday in a
field.

## Rotating the release key

1. Mint a new pair with `node scripts/release-key.mjs`.
2. Add the **public** half to `TRUSTED_KEYS` — do not remove the old one. Add
   it to the apps' copies too, as the 32 bytes the script prints in base64:
   `TRUSTED_KEYS` in `Screens.java` and `trustedKeys` in `ScreensPlugin.swift`,
   in the same order. A server test fails until all three agree.
3. Ship a release, still signed with the old key. Boxes updating to it learn
   the new key, and so do phones as their apps update to it: an iPhone from
   the App Store, an Android phone from that release's APK once it is on a box.
4. Wait. Every box that has not taken that release still trusts only the old
   key, and so does every phone whose app hasn't.
5. Once the field has caught up, change `RELEASE_SIGNING_KEY` in CI to the new
   private half.
6. Remove the old public key only when nothing that old is still running.

Skipping step 3 or 4 strands every box that has not updated yet. A phone is
not stranded the same way: an app that doesn't know the key a box's screens
were signed with takes them as unsigned, and keeps running its own. But it
stops following its box, and once the box speaks a protocol its own screens
can't, it says to update the app.

## Known limits

**Not yet run on real hardware.** As of v0.18.0 the Windows
rename-while-running path and the macOS bundle swap are reasoned from
documented operating-system behaviour and tested against a real filesystem,
but no Windows box and no Mac has yet updated itself. Linux is exercised for
real in the test suite. Treat the first update on each platform as a thing to
do with a spare box, not ten minutes before doors.

**Phones taking a box's screens have not been tried on a real phone.** The
Android app's side runs in JVM tests. The iPhone app's is compiled in CI, and
a server test holds its names, limits and keys to Android's. The browser tests
stand in for both apps with the plugin written in JavaScript. Try the first
switch with a spare phone and a spare box.

**The twenty seconds is an estimate**, not a measurement — process start plus
the web-bundle extraction a packaged box does on boot.

**There is no automatic update.** A box never installs anything on its own,
at any hour, under any circumstances. It asks, and waits.
