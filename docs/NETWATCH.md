# Watching the audio & media network

`CREWBOX_DMX` gave the box ears on the lighting network. `CREWBOX_WATCH=1`
does the same for the audio/media network: PTP clock health, a
Dante/NDI/NMOS device roster, and the AES67 and ST 2110 stream directory —
all overheard, never asked for. On an ST 2110 rig the box also checks what
it overhears against the standards: each stream's SDP file, and the video
clock against SMPTE ST 2059-2 ([below](#the-st-2110-checks)).

## The one rule, again

Crewbox never transmits on a production network. The watchers reuse the DMX
listener's `receiveOnly` — `send` is removed from every socket before first
use, and the test suite asserts it throws. Everything below is learned from
traffic that multicasts to the whole network anyway.

The box does multicast one thing, and it is not a watcher: it announces
itself on the **crew** network so the phone apps can find it
(`server/src/announce`, [DISCOVERY.md](DISCOVERY.md)). Its own socket, its own
adapter, and in its automatic setting it stays quiet whenever a watcher is on
the crew adapter or was left to the operating system's choice, since then the
crew network may be this one. Only an admin choosing **Always** puts it on a
network a watcher shares, and the panel names that choice for what it is.

The other is the Network audit's deep probe, which only an admin can start:
one mDNS question for Dante and NDI devices and NMOS registries, so the
roster fills in without waiting for their next announcements, and, when
there is an NMOS registry, a read of it over HTTP. The question leaves by
the adapter `CREWBOX_WATCH_IFACE` names, and by whichever one the operating
system picks for multicast when nothing does; the read leaves from that
adapter's address, or by the operating system's route to the registry when
nothing is named ([NETWORK_AUDIT.md](NETWORK_AUDIT.md)).

## What it watches

| Watcher | Where                      | What it learns                                                                                                                                          |
| ------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PTP     | 224.0.1.129, ports 319/320 | Who the clock grandmaster is, whether that has been changing, whether an election is live; on the video domain, whether the clock keeps SMPTE ST 2059-2 |
| mDNS    | 224.0.0.251:5353           | Dante devices (`_netaudio-*._udp`), NDI sources (`_ndi._tcp`), and NMOS nodes and registries (`_nmos-*._tcp`): names, addresses, appearances, goodbyes  |
| SAP     | 239.255.255.255:9875       | AES67/RAVENNA and ST 2110 stream announcements: name, destination, origin, and the SDP file itself                                                      |

The line that pays for the feature is the clock one. A PTP grandmaster
election war is the audio fault every device suffers at once — clicks and
dropouts across the whole rig as everything relocks — and nothing on a desk
says why. The election itself is multicast, so a passive listener watches it
happen and the panel can say "the grandmaster changed 3 times in the last
ten minutes, starting 14:32".

## Enabling it

```sh
CREWBOX_WATCH=1 CREWBOX_WATCH_IFACE=10.10.0.2 ./crewbox
```

`CREWBOX_WATCH_IFACE` is the address of the adapter with a leg on the audio
network — an interface for joining multicast groups, not a bind address,
for the same Linux reason as `CREWBOX_DMX_IFACE`. On a box with one adapter
it can be omitted.

Off by default. When off, the panel section does not appear at all.

## The ST 2110 checks

The checks are legofsalmon/st2110's, written in Rust and carried here as
WebAssembly in the `st2110` workspace, whose README says which commit they
were built from and how to build them again. The box and the browser run
the same build. What the box does with them, all from traffic it already
overhears:

- **SDP files.** Every SAP announcement carries its stream's SDP file. One
  that describes an ST 2110 stream (video, ancillary data and the rest, or
  audio that says it is ST 2110-30) is checked against the standards once
  for each version of the file. The readiness panel's "ST 2110 streams" line
  lists the faults, and the audit's media card grades them. AES67 streams
  stay under AES67's rules: a Dante stream's clock offset is AES67's to
  allow, and ST 2110's to forbid.
- **The video clock.** PTP messages on domain 127, ST 2059-2's default, or
  on a domain an ST 2059-2 synchronization-metadata message names, are
  checked against the profile: message rates, the grandmaster's class and
  timescale, the UTC offset, and the time code metadata. Dante's domain 0 is
  never judged by the video profile. At most one message of each kind from
  each clock is decoded a second, and at most 512 clocks are followed, so a
  flood of PTP is not a flood of work. A grandmaster running free is
  described, not faulted; a wrong UTC offset is a fault, because every time
  code made from the clock is out by it.
- **The NMOS registry**, in the deep probe only: what is registered, whose
  clocks it follows, the connections, and every sender's SDP file.

The browser runs the rest on the device, from the Network page: an SDP file
gone through line by line, and a packet capture measured as SMPTE RP 2110-25
describes. The capture analyser runs in a worker of its own, started for
each capture and torn down after it, so a big capture's memory goes when the
worker does. Neither tool sends the file anywhere, the box included.

A module that will not load is a line on the readiness panel ("ST 2110
checks"), not a crash, and everything that uses the checks treats "not
checked" as not checked, never as fine.

## Honesty notes

- **PTPv1 (classic Dante) is reported as presence only.** The v2 Announce
  decode is complete; v1's grandmaster fields are deliberately not decoded
  until verified against captured Dante traffic — a confidently mis-parsed
  clock identity is worse than a counted presence. Same rule the DMX layer
  applied before its own field capture.
- **Dante Domain Manager sites can move discovery off mDNS.** An empty
  Dante roster under DDM is expected, not evidence of absence.
- **Dante flows appear in the stream directory only in AES67 mode.** Native
  Dante flows are negotiated privately; the SAP directory is the
  standards-world view.
- **Ports may be contested.** mDNS responders (Bonjour, Avahi) and PTP
  daemons (Dante Virtual Soundcard) hold these same ports; the sockets open
  with address reuse, and where the OS still refuses, the panel names the
  watcher that is dark rather than the box failing to start. On Linux,
  ports 319/320 are below 1024, so binding them takes
  `CAP_NET_BIND_SERVICE`, root, or `net.ipv4.ip_unprivileged_port_start`
  lowered. The systemd rig's unit (`deploy/systemd/crewbox.service`)
  already grants that capability; the packaged box, which `install.sh`
  runs as a service of the user's own, does not. The panel says when they
  could not be opened.
- **Like the DMX layer at its birth, all of this is spec-synthesised.**
  IEEE 1588-2008, RFC 6762/6763, RFC 2974 and SDP are well-trodden, but no
  packet here has been checked against a real stagebox yet. The sniffer
  script pattern (`scripts/dmx-sniff.mjs`) is the model for validating it
  when a Dante rig is in reach. The ST 2110 checks are tested against
  legofsalmon/st2110's own fixtures, which are built from the standards
  too: no ST 2110 device has been on the other end yet either.

## The bridging warning applies here too

A box with a leg on the audio VLAN bridges it to the crew network exactly as
the RUNBOOK warns for lighting. Same answer: make it a deliberate decision,
per venue.
