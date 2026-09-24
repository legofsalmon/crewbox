# Watching the audio & media network

`CREWBOX_DMX` gave the box ears on the lighting network. `CREWBOX_WATCH=1`
does the same for the audio/media network: PTP clock health, a Dante/NDI
device roster, and the AES67 stream directory — all overheard, never asked
for.

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
one mDNS question for Dante and NDI devices, so the roster fills in without
waiting for their next announcements. It leaves by the adapter
`CREWBOX_WATCH_IFACE` names, and by whichever one the operating system picks
for multicast when nothing does ([NETWORK_AUDIT.md](NETWORK_AUDIT.md)).

## What it watches

| Watcher | Where                      | What it learns                                                                                            |
| ------- | -------------------------- | --------------------------------------------------------------------------------------------------------- |
| PTP     | 224.0.1.129, ports 319/320 | Who the clock grandmaster is, whether that has been changing, whether an election is live                 |
| mDNS    | 224.0.0.251:5353           | Dante devices (`_netaudio-*._udp`) and NDI sources (`_ndi._tcp`): names, addresses, appearances, goodbyes |
| SAP     | 239.255.255.255:9875       | AES67/RAVENNA stream announcements: name, destination, origin                                             |

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
  when a Dante rig is in reach.

## The bridging warning applies here too

A box with a leg on the audio VLAN bridges it to the crew network exactly as
the RUNBOOK warns for lighting. Same answer: make it a deliberate decision,
per venue.
