# Getting comms audio in and out of the box over RTP

_Feasibility, written 11 August 2026 against crewbox v0.15.0. This is a
decision document, not a design that has been built._

The ask: a "plain RTP seam" — a way for the crew's comms audio to leave the
box as an RTP stream a desk can receive, and for audio from the desk to
arrive on a crewbox channel. This is the right thing to want. Every other
piece of comms gear at a festival can be patched: an intercom belt pack
lands on a matrix, a talkback mic lands on a console, programme audio goes
everywhere. Crewbox is currently an island, and an island is where somebody
ends up holding a phone against a mic.

This document is the honest answer about what that costs, because the cost
is not in the RTP.

## The finding, first

**Crewbox cannot do this today at any cost in application code, because the
box has no media plane in its own process.** The audio never passes through
the crewbox server: phones publish Opus to the embedded `livekit-server`,
which forwards it to other phones. Node holds the signalling, the tokens and
the room list; it never holds a sample.

Everything below is a way of getting a media plane, and each one takes
something away from what the box is — one file, no dependencies, nothing to
install on site. That trade is not mine to make silently, which is why this
is a document rather than a branch.

## What "plain RTP" means to three different people

Worth separating, because the same three words describe jobs of very
different sizes.

1. **"Put comms on the desk."** An AES67 (or Dante-in-AES67-mode) stream the
   console can subscribe to. This is what a systems tech means.
2. **"Give me a feed I can point VLC or ffmpeg at."** A plain unicast or
   multicast RTP/Opus stream with a hand-written SDP. This is what a
   broadcast engineer improvising a monitor feed means.
3. **"Tie crewbox into the intercom."** A SIP endpoint, because Riedel,
   Green-GO, Clear-Com and Unity all speak SIP and that is how comms systems
   are joined to each other. This is what a comms tech means.

They share a transport and share nothing else. (1) is the most valuable and
the most expensive; (2) is nearly free once a media plane exists; (3) is a
different project with a different protocol stack.

## What AES67 actually requires

Verified against the AES67 practical guides and the AIMS interop notes:

- **L24 (or L16) linear PCM.** Not Opus. LiveKit carries Opus, so every path
  to (1) includes an Opus decode and a resample to the network's clock.
- **1 ms packet time** as the mandatory interoperable ptime (48 kHz, so 48
  samples per packet, ~1000 packets/sec/stream).
- **PTPv2 (IEEE 1588-2008), AES67 media profile.** The sender's RTP
  timestamps must be derived from the PTP-disciplined clock, not from a
  free-running `Date.now()`. This is the expensive requirement: a receiver
  fed a free-running stream either refuses it or slips its buffer, and "it
  crackles every few minutes" is the worst failure mode this project could
  ship into a show.
- **SDP over SAP** for discovery.

Crewbox already has the *receive* halves of the last two: `netwatch/ptp.ts`
decodes PTPv2 Announce messages and reports grandmaster health, and
`netwatch/sap.ts` parses the SAP/SDP announcements that make up an AES67
stream directory. Both are strictly read-only by design, and being able to
*watch* a grandmaster is a long way from being *slaved* to one.

## The four routes to a media plane

### A. LiveKit Ingress / Egress

Both are separate services that talk to `livekit-server` **through a shared
Redis**, and neither speaks plain RTP: Ingress takes RTMP, WHIP and URL
pull; Egress pushes to files, RTMP and a WebSocket.

Cost: Redis plus a second and third binary in a box whose entire pitch is
that it is one file. Redis alone ends the "nothing to install" promise, and
neither service gets us to (1) anyway.

**Rejected.** Not because it is hard, but because it does not do the job.

### B. LiveKit SIP

Also a separate service, also Redis, listening on 5060 with an RTP media
range of 10000–20000.

It is the only LiveKit component that touches RTP directly, and it is
aimed squarely at use case (3). If tying crewbox into a house intercom
becomes the goal, this is the route to re-examine — but it inherits the same
Redis and second-binary cost, and it answers a question nobody has asked yet.

**Parked**, and it is the right thing to park rather than reject: a comms
product that speaks SIP is a comms product that plugs into every intercom on
the market.

### C. A media-plane participant inside the box (`@livekit/rtc-node`)

The one that stays closest to the current architecture. `@livekit/rtc-node`
(0.13.33 today) wraps LiveKit's Rust client through
`@livekit/rtc-ffi-bindings`, and gives Node `AudioSource` and `AudioStream`
— raw PCM frames in and out of a room. A bot participant joins the intercom
room, and from there RTP is ordinary socket work this codebase already does
well.

The catch is packaging. The bindings ship as per-platform native addons:
`darwin-x64`, `darwin-arm64`, `linux-x64-gnu`, `linux-arm64-gnu`,
`win32-x64-msvc`. That means:

- **No musl.** An Alpine box would lose voice bridging silently.
- **No Windows on ARM.**
- **The universal macOS build gets harder.** Two arch-specific dylibs to
  `lipo`, inside a `.node` file, inside a signed and notarised app.
- The single-file box would extract a native addon at boot. That trick is
  already in the codebase (`seaAsset` extracts `livekit-server` the same
  way), so it is precedent rather than novelty — but a native addon is a
  different risk profile from a standalone child process: it shares our
  address space, and a crash takes the box down rather than the SFU.

Cost: real, contained, and it keeps one binary. It buys (2) immediately and
(1) only after Opus decode and clock discipline.

### D. A fetched Go bridge binary

`livekit/server-sdk-go` is built on pion, which hands over `*rtp.Packet`
directly — so the Opus payloads the SFU is already forwarding could be
relayed to a UDP destination almost verbatim, no transcode, no decode.
Cross-compiled Go with no cgo is exactly what `livekit-server` is, and
`scripts/fetch-livekit.mjs` is the precedent for shipping such a thing.

The difference from that precedent is maintenance: fetching somebody else's
release is free forever, and shipping our own Go component means a second
toolchain, a second cross-compile matrix, a second thing to sign on macOS,
and a second thing to keep current with LiveKit's protocol. That is a
standing cost on a project maintained by one person.

## Recommendation

**Do not build this yet, and do not build it as designed.** If the goal is
(1) — comms on the desk, properly — the honest scope is:

1. Route C to get a media plane (native addon, single binary preserved).
2. An Opus decode to 48 kHz PCM.
3. A PTPv2 slave — not a watcher — so RTP timestamps are on the network's
   clock, plus the drift correction that goes with it.
4. L16/L24 packetisation at 1 ms, SDP generation, SAP announcement, IGMP.
5. A readiness row that says plainly when the box is not locked to a
   grandmaster, because a stream that is silently free-running is worse than
   no stream.

That is a project on the scale of the DMX or lighting modules, and step 3 is
the one that decides whether it works on a real network. Steps 4 and 5 are
where this codebase is already strong.

**A much cheaper first move**, if the desire is really (2): route C plus a
plain RTP/Opus send with a downloadable SDP file, no PTP, no transcode,
announced as what it is — "a monitor feed for ffmpeg, VLC, or another
crewbox", explicitly not an AES67 source. Perhaps a week rather than a
month, and it would tell us whether anyone actually patches it in anger
before the expensive half gets built.

## What I would want to know before starting

- Which of the three jobs is the real one? A systems tech asking for AES67
  and a producer asking for a monitor feed want different products.
- Is there a desk or a receiver available to test against? Step 3 cannot be
  verified by unit tests, and an AES67 sender that has never met a real
  receiver is a guess with a version number.
- Is a native addon acceptable inside the box binary, given it removes the
  process isolation the SFU currently enjoys?
- Does the intercom-integration route (B, SIP) matter more than the desk
  route? It is the one that would make crewbox a peer of the gear already in
  the racks.

## Sources

- LiveKit Ingress and SIP self-hosting requirements (Redis, separate
  service, protocol support), checked 11 August 2026.
- `@livekit/rtc-node` 0.13.33 / `@livekit/rtc-ffi-bindings` 0.12.75 platform
  list, read from the npm registry the same day.
- AES67 practical guides and AIMS Alliance interoperability notes for L24,
  1 ms ptime, PTPv2 media profile and SDP-over-SAP discovery.
