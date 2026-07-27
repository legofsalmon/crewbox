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
NAME="Smoke Test $$"
BASE="http://127.0.0.1:$PORT"
DATA="$(mktemp -d)"
LOG="$DATA/box.log"
PID=""

pass() { echo "  ok    $1"; }
fail() {
  echo "  FAIL  $1" >&2
  echo "" >&2
  echo "--- box output ---" >&2
  tail -40 "$LOG" >&2 2>/dev/null || true
  exit 1
}

cleanup() {
  [ -n "$PID" ] && kill "$PID" 2>/dev/null || true
  rm -rf "$DATA"
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
[ "$(uname -s)" = "Darwin" ] && xattr -d com.apple.quarantine "$BIN" 2>/dev/null

# Under Git Bash a path like /tmp/tmp.abc means nothing to a native Windows
# binary — Node would resolve it against the current drive and write to
# C:\tmp\… while this script cleans up somewhere else entirely. Hand the box a
# Windows path so both ends agree on where the data directory is.
DATA_ARG="$DATA"
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) DATA_ARG="$(cygpath -w "$DATA")" ;;
esac

DATA_DIR="$DATA_ARG" CREWBOX_PORT="$PORT" EVENT_PIN="$PIN" CREWBOX_NO_OPEN=1 \
  "$BIN" >"$LOG" 2>&1 &
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
echo "$health" | grep -q '"ok":true' || fail "health is not ok: $health"
pass "health: $(echo "$health" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"

curl -fsS "$BASE/" | grep -qi '<div id="root"\|<title' || fail "web app not served"
pass "serves the web app"

curl -fsS "$BASE/setup" | grep -q 'name="eventName"' || fail "/setup did not render"
pass "first-run setup page"

code="$(curl -fsS -o /dev/null -w '%{http_code}' -X POST "$BASE/setup" \
  --data-urlencode "eventName=$NAME" --data-urlencode "wifiSsid=SmokeNet" \
  --data-urlencode "eventPin=$PIN")"
[ "$code" = "302" ] || fail "POST /setup returned $code, expected 302"
pass "setup saves and redirects"

connect="$(curl -fsS "$BASE/connect")"
echo "$connect" | grep -qF "$NAME" || fail "/connect does not show the event name"
echo "$connect" | grep -qF "$PIN" || fail "/connect does not show the event PIN"
pass "join page shows the event and PIN"

join="$(curl -fsS -X POST "$BASE/api/join" -H 'content-type: application/json' \
  -d "{\"name\":\"Smoke\",\"eventPin\":\"$PIN\",\"personalPin\":\"1234\"}")"
token="$(echo "$join" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
[ -n "$token" ] || fail "join failed: $join"
echo "$join" | grep -q '"role":"admin"' || fail "first joiner is not admin: $join"
pass "first crew member joins as admin"

ready="$(curl -fsS "$BASE/api/admin/settings" -H "authorization: Bearer $token")"
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
