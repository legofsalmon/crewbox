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

Adding a key to that list is a decision about who may take over every crewbox
in existence. It deserves a conversation, not a commit.

## Checking a build yourself

You do not have to trust the box, or this code, to check what you downloaded.

Every release carries `SHA256SUMS-<version>` — plain `sha256sum` output, one
line per asset — and `SHA256SUMS-<version>.sig`, a detached ed25519 signature
over it.

**The bytes:**

```bash
sha256sum -c SHA256SUMS-v0.18.0
```

Every file you downloaded should say `OK`. Files you did not download are
reported as missing, which is fine.

**The signature**, with the public key from `verify.ts`:

```bash
# Save the public key as crewbox-release.pub.pem, then:
openssl pkeyutl -verify \
  -pubin -inkey crewbox-release.pub.pem \
  -rawin -in SHA256SUMS-v0.18.0 \
  -sigfile <(base64 -d SHA256SUMS-v0.18.0.sig)
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

**3. Only then is the port released.** The box stops listening, drops every
WebSocket, and the new process starts.

**4. The old process watches.** It stays alive, waiting for the new box to
write its status file. This is the arrangement that makes rollback possible at
the moment it is needed: a build that will not start cannot be the thing that
notices it did not start.

**5. If the new box never answers**, within forty-five seconds, the old binary
goes back, the old process starts listening again, and the panel says what
happened. The box is exactly where it was.

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

## Recovering by hand

**The new box will not start and the rollback failed.** The old binary is at
`<name>.old` beside it. Rename it back and start it.

**The database is wrong after a rollback.** Snapshots are in
`<data dir>/snapshots/`, newest first, named with the version they belong to.
Stop the box, copy the one matching your binary's version over
`<data dir>/crewbox.db`, and start it. Delete any `crewbox.db-wal` and
`crewbox.db-shm` beside it first.

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
2. Add the **public** half to `TRUSTED_KEYS` — do not remove the old one.
3. Ship a release, still signed with the old key. Boxes updating to it learn
   the new key.
4. Wait. Every box that has not taken that release still trusts only the old
   key.
5. Once the field has caught up, change `RELEASE_SIGNING_KEY` in CI to the new
   private half.
6. Remove the old public key only when nothing that old is still running.

Skipping step 3 or 4 strands every box that has not updated yet.

## Known limits

**Not yet run on real hardware.** As of v0.18.0 the Windows
rename-while-running path and the macOS bundle swap are reasoned from
documented operating-system behaviour and tested against a real filesystem,
but no Windows box and no Mac has yet updated itself. Linux is exercised for
real in the test suite. Treat the first update on each platform as a thing to
do with a spare box, not ten minutes before doors.

**The twenty seconds is an estimate**, not a measurement — process start plus
the web-bundle extraction a packaged box does on boot.

**There is no automatic update.** A box never installs anything on its own,
at any hour, under any circumstances. It asks, and waits.
