# The network audit

The **Network** module grades every network crewbox can see for A/V use —
live, for the whole crew, with the history to back it up and a one-click
HTML report to hand to venue IT. This document is the contract: what is
collected, what is (and is never) transmitted, and how long anything is
kept.

## What is collected, passively, all the time

The collector samples state the passive listeners already keep — it opens
no sockets and sends nothing. Every five seconds it reads:

| Series                                                    | Source                                      |
| --------------------------------------------------------- | ------------------------------------------- |
| `crew.connections`, `crew.onlineUsers`                    | the chat hub                                |
| `dmx.rateHz`, `dmx.lossPct`, `dmx.sources` (per universe) | the DMX listener (`docs/DMX_MONITORING.md`) |
| `media.ptpAnnouncers`, `media.ptpV1RateHz`                | the PTP watcher (`docs/NETWATCH.md`)        |
| `media.mdnsDevices`, `media.sapStreams`                   | the mDNS/SAP watchers                       |
| `watch.packets` (per watcher)                             | packet counters, as per-minute deltas       |

Samples roll up to **one row per minute** (min/avg/max/count). Discrete
events — a grandmaster change, an outage, a conflict starting or ending, a
device saying goodbye — are recorded as they transition, once each.

**Retention: 7 days**, pruned hourly. Bounds are structural: one small
write transaction a minute, at most 64 keys per metric, at most 500 events
an hour. A five-day festival's full history is tens of megabytes; a power
cut loses at most the last minute.

## The grades

Three cards — crew, lighting, media — each `ok / limited / off`, or
`unknown` when the box isn't watching that network (never a fake ok).
Every non-ok finding carries its fix, and where history backs a finding
the sparkline is drawn beside it. Notable inferences:

- **Missing IGMP querier**: outages recurring on a quasi-regular ~4–5
  minute rhythm are the group-timeout cycle that IGMP snooping without a
  querier produces. Crewbox reports this **from symptoms alone** — see
  below for why it never sends IGMP itself.
- **Sustained loss** is judged over 15 minutes, not one glance, and a
  universe whose loss cannot be measured (Art-Net with sequencing off)
  is never counted as 0%.

## The deep probe — the one time crewbox transmits

Everything above is receive-only, always. The **deep probe** is a single,
admin-triggered sweep; the results are visible to everyone, but only an
unlocked admin can start one. Each probe records a `sent` line in the
report — exactly what was transmitted, so a venue can verify it against a
packet capture.

| Probe             | Transmits                                                                                   | Where                                                                        | Why it's safe                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Uplink            | TCP connects to 1.1.1.1:443 / 8.8.8.8:443, one HTTP request to gstatic `generate_204`       | crew uplink                                                                  | identical to the existing admin environment check                                                                                  |
| Venue DNS         | one A query for the certificate hostname                                                    | system resolver                                                              | one DNS packet                                                                                                                     |
| Art-Net inventory | **one** ArtPoll (14 bytes, opcode 0x2000, no diagnostics requested) broadcast to :6454      | **only** the explicitly configured lighting interface; **skipped otherwise** | ArtPoll is the discovery packet every console already broadcasts every ~3 s; one more per manual push is less than ambient traffic |
| mDNS roster       | one one-shot query (PTR `_netaudio-arc._udp.local` + `_ndi._tcp.local`) to 224.0.0.251:5353 | media-watch interface                                                        | the same query every phone on the network performs continuously (RFC 6762 §5.1)                                                    |

Probe sockets are created inside the sweep and closed when it ends; the
replies they solicit arrive on the existing **receive-only** listeners,
which keeps that guarantee structurally intact.

### What the probe will never do, and why

- **No IGMP, in either direction.** Receiving it is impossible without
  root (IGMP is IP protocol 2, not UDP). Sending general queries is
  actively dangerous: crewbox could win the querier election and then
  stop querying when the sweep ends — at which point snooping switches
  age out every multicast group, and the whole network drops audio on a
  cycle. That is precisely the fault the audit exists to find, so it is
  diagnosed from symptoms instead.
- **Nothing on the PTP ports.** Transmitting near a clock election risks
  disturbing it; the passive `ClockStatus` already tells the story.
- **No ICMP sweeps, no port scans.** Root-required, and show-network
  devices have watchdogs that treat scans as hostility.
- **No sACN of any kind.** E1.31 universe discovery is already broadcast
  by every source every 10 seconds and collected passively.

At venues that prohibit any transmission on the lighting VLAN: simply
don't press the button — the passive audit loses nothing it had, and the
ArtPoll probe is skipped anyway unless a lighting interface is explicitly
configured.

## Verified on hardware?

The packet builders are tested byte for byte, and the sweep's socket
lifecycle is unit-tested with fakes. What still needs a real rig:

- [ ] ArtPoll against a physical Art-Net node (does the inventory grow?)
- [ ] the mDNS query against a Dante device (does the roster grow?)

Until those boxes are ticked, treat the two discovery probes as
unverified-on-hardware — the failure mode is a probe that finds nothing,
not one that disturbs anything.
