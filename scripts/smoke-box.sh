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
pass "health: $(echo "$health" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"

index="$(curl -fsS "$BASE/")"
contains "$index" '<div id="root"' || contains "$index" '<title' || fail "web app not served"
pass "serves the web app"

contains "$(curl -fsS "$BASE/setup")" 'name="eventName"' || fail "/setup did not render"
pass "first-run setup page"

code="$(curl -fsS -o /dev/null -w '%{http_code}' -X POST "$BASE/setup" \
  --data-urlencode "eventName=$NAME" --data-urlencode "wifiSsid=SmokeNet" \
  --data-urlencode "eventPin=$PIN")"
[ "$code" = "302" ] || fail "POST /setup returned $code, expected 302"
pass "setup saves and redirects"

connect="$(curl -fsS "$BASE/connect")"
contains "$connect" "$NAME" || fail "/connect does not show the event name"
contains "$connect" "$PIN" || fail "/connect does not show the event PIN"
pass "join page shows the event and PIN"

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

ready="$(curl -fsS "$BASE/api/admin/settings" \
  -H "authorization: Bearer $token" -H "x-admin-token: $admin_token")"
state_of() {
  echo "$ready" | sed "s/.*\"id\":\"$1\"//" | sed 's/}.*//' |
    grep -o '"state":"[^"]*"' | head -1 | sed 's/.*:"//;s/"//'
}

[ "$(state_of chat)" = "ok" ] || fail "chat/patch/lighting not ok"
pass "chat, patch sheets and lighting ready"

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

echo ""
echo "PASS — this box works, voice included."
echo ""
