#!/bin/sh
# Prove a built box binary actually works, by running it and using it.
#
# Usage: scripts/smoke-box.sh ./build/box/crewbox-darwin-arm64
#
# Plain sh and curl on purpose: this has to run on a festival admin's Mac
# against a downloaded release, where there is no Node, no repo and no
# toolchain. It is the same check CI runs on every build.
#
# What it is really for: the box can build perfectly and still ship without a
# working voice server — a missing SFU asset, an SFU that won't execute on
# that OS, a universal binary whose slices lost their payload. None of that
# shows up in a build log. All of it shows up here, because this starts the
# thing and asks it.
set -eu

BIN="${1:-}"
if [ -z "$BIN" ] || [ ! -f "$BIN" ]; then
  echo "usage: $0 <path-to-crewbox-binary>" >&2
  exit 2
fi
command -v curl >/dev/null 2>&1 || {
  echo "curl is required" >&2
  exit 2
}

PORT="${CREWBOX_SMOKE_PORT:-8799}"
PIN=4242
# Handed to the box below, so this script knows the admin password rather than
# having to scrape it out of the box's own log.
ADMIN_PASSWORD=smoke-admin-password
NAME="Smoke Test $$"
BASE="http://127.0.0.1:$PORT"
DATA="$(mktemp -d)"
LOG="$DATA/box.log"
PID=""

REPORTED=0

# Substring match without a pipe.
#
# `printf … | grep -q` is the obvious way to write these checks and it prints
# "write error: Broken pipe" beside a check that passed: grep -q exits at the
# first match, and the writer then dies filling a pipe nobody is reading. It
# only shows up once the haystack outgrows the pipe buffer, so it appeared in
# a release log long after the line was written, looking like a fault.
contains() { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }

# The SHA-256 of stdin, in hex. A Mac has shasum and no sha256sum.
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | cut -d ' ' -f 1
  else
    shasum -a 256 | cut -d ' ' -f 1
  fi
}

pass() { echo "  ok    $1"; }
fail() {
  REPORTED=1
  echo "  FAIL  $1" >&2
  echo "" >&2
  echo "--- box output ---" >&2
  tail -40 "$LOG" >&2 2>/dev/null || true
  exit 1
}

cleanup() {
  status=$?
  if [ -n "$PID" ]; then
    kill "$PID" 2>/dev/null || true
    # Wait for it to actually go before touching its files.
    #
    # `kill` returns as soon as the signal is delivered, not when the process
    # has died. Unix does not care — you can unlink a file another process
    # still has open — but Windows refuses, so `rm -rf` hit "Device or
    # resource busy" on crewbox.db and failed a run whose every check had
    # passed. The same lesson as reaping an orphaned SFU: wait for it to go.
    i=0
    while kill -0 "$PID" 2>/dev/null && [ "$i" -lt 10 ]; do
      i=$((i + 1))
      sleep 1
    done
  fi
  # Never let tidying up fail a run that passed. A leftover temp directory on
  # a CI runner that is about to be destroyed is not worth a red build.
  rm -rf "$DATA" 2>/dev/null || true
  # A non-zero exit with no FAIL line above it means the script died rather
  # than the box failing a check — almost always a command tripping `set -e`.
  # Say which, because a silent exit 1 reads as "this box is broken" and
  # sends someone hunting the wrong thing.
  if [ "$status" -ne 0 ] && [ "$REPORTED" -eq 0 ]; then
    echo "" >&2
    echo "smoke test aborted (exit $status) before any check ran." >&2
    echo "That is this script failing, not the box. Re-run with 'sh -x' to see where." >&2
  fi
}
trap cleanup EXIT INT TERM

echo ""
echo "Smoke-testing $BIN"
echo ""

# Architecture, where the platform can tell us. A universal binary that only
# carries one slice is a silent failure on half the Macs out there.
if command -v lipo >/dev/null 2>&1; then
  echo "  arch  $(lipo -archs "$BIN" 2>/dev/null || echo unknown)"
fi

chmod +x "$BIN" 2>/dev/null || true
# Downloaded binaries are quarantined; without this macOS refuses to run it
# and the failure looks like a crash rather than a policy decision.
#
# `|| true` is load-bearing. A binary that was built here rather than
# downloaded has no quarantine attribute, so `xattr -d` exits non-zero, and
# under `set -e` that killed the whole script — on macOS only, and only when
# the binary was *not* quarantined, which is exactly the CI case.
if [ "$(uname -s)" = "Darwin" ]; then
  xattr -d com.apple.quarantine "$BIN" 2>/dev/null || true
fi

# Under Git Bash a path like /tmp/tmp.abc means nothing to a native Windows
# binary — Node would resolve it against the current drive and write to
# C:\tmp\… while this script cleans up somewhere else entirely. Hand the box a
# Windows path so both ends agree on where the data directory is.
DATA_ARG="$DATA"
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) DATA_ARG="$(cygpath -w "$DATA")" ;;
esac

DATA_DIR="$DATA_ARG" CREWBOX_PORT="$PORT" EVENT_PIN="$PIN" CREWBOX_NO_OPEN=1 \
  ADMIN_PASSWORD="$ADMIN_PASSWORD" "$BIN" >"$LOG" 2>&1 &
PID=$!

# The box extracts its web bundle and starts the SFU before listening, so the
# first second or two is expected to fail.
i=0
until curl -fsS "$BASE/api/health" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -gt 60 ] && fail "never started listening on $PORT"
  kill -0 "$PID" 2>/dev/null || fail "exited during startup"
  sleep 1
done
pass "starts and listens on $PORT"

health="$(curl -fsS "$BASE/api/health")"
contains "$health" '"ok":true' || fail "health is not ok: $health"
box_version="$(echo "$health" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
pass "health: $box_version"

index="$(curl -fsS "$BASE/")"
contains "$index" '<div id="root"' || contains "$index" '<title' || fail "web app not served"
pass "serves the web app"

# The screens as an app will check them before it runs them
# (scripts/web-sums.mjs): built as the version this box says it is, and every
# file WEBSUMS lists served as the bytes that were signed, compressed or not.
# A missing file is no 404 here, because a box answers any path it doesn't
# know with the app shell, so each check is of what actually came back.
#
# CREWBOX_SMOKE_SIGNED=1, as CI and every release set it, insists on signed
# screens. Without it, a box built on screens nobody signed passes as a build
# of its own, and so does one from before the screens said which they were.
signed="${CREWBOX_SMOKE_SIGNED:-0}"
web_info="$(curl -fsS "$BASE/crewbox-web.json" || true)"
if contains "$web_info" '"kind": "crewbox-web"'; then
  web_version="$(echo "$web_info" | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p')"
  [ "$web_version" = "$box_version" ] ||
    fail "the screens were built as '$web_version' but the box is $box_version: an app would refuse them"
  sums="$(curl -fsS "$BASE/WEBSUMS" || true)"
  if contains "$sums" '  crewbox-web.json'; then
    sig="$(curl -fsS "$BASE/WEBSUMS.sig" || true)"
    case "$sig" in
      '' | *[!A-Za-z0-9+/=]*) fail "WEBSUMS is served without its signature" ;;
    esac
    count=0
    # A here-document, not a pipe, so a fail inside the loop ends the script.
    while read -r digest path; do
      got="$(curl -fsS --compressed "$BASE/$path" | sha256)"
      [ "$got" = "$digest" ] || fail "$path is not served as it was signed"
      count=$((count + 1))
    done <<EOF
$sums
EOF
    pass "serves its screens as signed ($count files)"
  elif [ "$signed" = 1 ]; then
    fail "the screens are not signed: no WEBSUMS lists them"
  else
    pass "serves its screens, unsigned (a build of its own)"
  fi
elif [ "$signed" = 1 ]; then
  fail "the box doesn't say which screens it serves: no crewbox-web.json"
fi

# First-run setup has two right answers. A release box is "trial, then lock"
# (LICENCE_POLICY in server/src/licence/decide.ts), and this script always
# starts it on an empty data directory, so it has never had a trial or a key:
# /setup shows the licence gate instead of the form, and a POST is refused
# with 423 and saves nothing. That is the product working, not a fault, and
# it is what every admin sees on a new box. A build whose policy is `open` or
# `watermark`, or that has no verifying key, shows the form and saves.
#
# Either way the page has to render, and a lock has to actually hold.
setup="$(curl -fsS "$BASE/setup")"
if contains "$setup" 'name="eventName"'; then
  LOCKED=0
  pass "first-run setup page"
elif contains "$setup" 'Licence needed'; then
  LOCKED=1
  # The way out of the gate is the Admin panel, so the page has to say how
  # to get there: the PIN to join with.
  contains "$setup" "$PIN" || fail "the licence gate on /setup does not show the event PIN"
  pass "first-run setup page (unlicensed: asks for a licence first)"
else
  fail "/setup rendered neither the setup form nor the licence gate"
fi

code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/setup" \
  --data-urlencode "eventName=$NAME" --data-urlencode "wifiSsid=SmokeNet" \
  --data-urlencode "eventPin=$PIN")"
if [ "$LOCKED" -eq 0 ]; then
  [ "$code" = "302" ] || fail "POST /setup returned $code, expected 302"
  pass "setup saves and redirects"
else
  [ "$code" = "423" ] || fail "POST /setup on an unlicensed box returned $code, expected 423"
  pass "setup is refused until the box has a licence"
fi

connect="$(curl -fsS "$BASE/connect")"
contains "$connect" "$PIN" || fail "/connect does not show the event PIN"
if [ "$LOCKED" -eq 0 ]; then
  contains "$connect" "$NAME" || fail "/connect does not show the event name"
  pass "join page shows the event and PIN"
else
  # The refused POST above must not have saved anything on the way out.
  if contains "$connect" "$NAME"; then
    fail "the refused setup saved the event name anyway"
  fi
  pass "join page shows the PIN, and the refused setup saved nothing"
fi

join="$(curl -fsS -X POST "$BASE/api/join" -H 'content-type: application/json' \
  -d "{\"name\":\"Smoke\",\"eventPin\":\"$PIN\",\"personalPin\":\"1234\"}")"
token="$(echo "$join" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
[ -n "$token" ] || fail "join failed: $join"
pass "first crew member joins"

# The admin panel is behind a password, so the smoke test has to unlock it the
# way a person does. ADMIN_PASSWORD was handed to the box above, which
# also proves the environment override works — the documented way back in
# when a box's password is lost.
unlock="$(curl -fsS -X POST "$BASE/api/admin/unlock" \
  -H "authorization: Bearer $token" -H 'content-type: application/json' \
  -d "{\"password\":\"$ADMIN_PASSWORD\"}")" ||
  fail "could not unlock the admin panel"
admin_token="$(echo "$unlock" | sed -n 's/.*"adminToken":"\([^"]*\)".*/\1/p')"
[ -n "$admin_token" ] || fail "unlock returned no token: $unlock"
pass "admin panel unlocks with the password"

# Locked is the default, and it has to actually mean something.
locked="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/admin/settings" \
  -H "authorization: Bearer $token")"
[ "$locked" = "403" ] || fail "admin panel answered $locked without an unlock, expected 403"
pass "panel stays shut without the password"

# The Licence section is how a locked box gets unlocked, and offline
# activation — the usual case on site — needs this box's request code, which
# is read from the OS differently on every platform. A locked box that cannot
# name itself can never be licensed without internet, so check that here,
# on each OS's real binary, rather than find out in a field.
licence="$(curl -fsS "$BASE/api/admin/licence" \
  -H "authorization: Bearer $token" -H "x-admin-token: $admin_token")" ||
  fail "the admin Licence section did not answer"
licence_status="$(echo "$licence" | grep -o '"status":"[^"]*"' | head -1 | sed 's/.*:"//;s/"//')"
[ -n "$licence_status" ] || fail "the Licence section answered without a status: $licence"
if [ "$LOCKED" -eq 1 ] && contains "$licence" '"requestCode":null'; then
  fail "locked, and no request code to activate offline with: $licence"
fi
pass "the Licence section answers (status: $licence_status)"

ready="$(curl -fsS "$BASE/api/admin/settings" \
  -H "authorization: Bearer $token" -H "x-admin-token: $admin_token")"
state_of() {
  echo "$ready" | sed "s/.*\"id\":\"$1\"//" | sed 's/}.*//' |
    grep -o '"state":"[^"]*"' | head -1 | sed 's/.*:"//;s/"//'
}

# The chat/patch/lighting readiness row is a constant in the box: those three
# need nothing but the box itself, so the row has nothing to report and is
# written 'ok'. Asserting it therefore proves the settings endpoint answered
# with a well-formed list — worth knowing, and all it is claimed to be.
[ "$(state_of chat)" = "ok" ] || fail "the readiness list came back without its chat row: $ready"
pass "the readiness list answers"

# What "patch sheets and lighting are there" actually depends on: the modules
# this box is running. A box started with CREWBOX_MODULES missing one of them
# serves a sidebar without that pane — and the readiness row above would still
# say ok, because it says ok on every box ever built.
config="$(curl -fsS "$BASE/api/config")" || fail "the box would not say which modules it runs"
modules="$(echo "$config" | sed -n 's/.*"modules":\[\([^]]*\)\].*/\1/p')"
for module in chat patch lighting; do
  # `contains`, not `grep -q`: see its comment at the top of this file.
  contains "$modules" "\"$module\"" || fail "$module is not enabled on this box: $config"
done
pass "chat, patch sheets and lighting are enabled"

voice="$(state_of voice)"
case "$voice" in
  ok | limited)
    # 'limited' is the honest answer on plain http: the SFU is running, and
    # only the browser microphone is gated on a secure context.
    pass "voice server running (state: $voice)"
    ;;
  *)
    fail "no voice server — the SFU did not start (state: ${voice:-unknown})"
    ;;
esac

# The menu-bar item, the tray icon and `--stop` all read this one file, so a
# box that doesn't publish it is a box nobody can stop from outside the
# terminal that started it. That shipped once already.
if [ -f "$DATA/box-status.json" ]; then
  pass "publishes box-status.json for the menu/tray helpers"
else
  fail "no box-status.json — nothing could find or stop this box"
fi

# And the flag that acts on it. This is the one stop mechanism that works on
# every platform, including a headless box over SSH.
# Same DATA_DIR the box was started with, or it looks in ~/.crewbox and finds
# nothing — which would pass for the wrong reason on a machine with no box.
DATA_DIR="$DATA_ARG" "$BIN" --status >/dev/null 2>&1 ||
  fail "--status did not report a running box"
pass "--status reports the running box"

DATA_DIR="$DATA_ARG" "$BIN" --stop >/dev/null 2>&1 || fail "--stop failed"
# Checked the moment it returns, with no grace period. `--stop` promises to
# wait for the box to be gone — the caller's next move is usually to replace
# the binary or take the port — and it used to wait for the *status file*,
# which the shutdown handler removes before it closes anything. Sleeping here
# would hide exactly the defect this line exists to catch.
if kill -0 "$PID" 2>/dev/null; then
  fail "--stop returned while the box process was still alive"
fi
if curl -fsS --max-time 3 "$BASE/api/health" >/dev/null 2>&1; then
  fail "--stop returned but the box is still serving"
fi
pass "--stop actually stops it"
# Already stopped, so cleanup has nothing to kill.
PID=""

echo ""
echo "PASS — this box works, voice included."
echo ""
