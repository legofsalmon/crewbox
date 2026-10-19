# The network map

What the box can say is on each network it has a leg on, put together from
what it has already overheard and from tables its operating system keeps.
It sends nothing. Served by `GET /api/netmap` (`server/src/netmap`), drawn at
**Network → Network map** (`web/src/modules/network/NetworkMap.tsx`).

**Status.** Built: stage 2 of the network roadmap (a map from what the box
already hears) and the box's half of stage 3 (Wi-Fi from a Linux box's cached
scans). **Nothing here has met real hardware.** Every table format below was
read from the tool's or kernel's source or documentation, and the parsers are
driven by samples written in those shapes. The Android scanner, the crew
sweep and reading switches over SNMP (stages 4 and 5) are not built.

The research behind it, with a citation for every platform claim, is in the
project's `network-map/research` notes (`platforms.md`, `crewbox-today.md`,
2026-09-24).

## How sure each claim is

| Label          | Means                                                        |
| -------------- | ------------------------------------------------------------ |
| **OBSERVED**   | Seen on a real box or rig, and reproduced                    |
| **DOCUMENTED** | Stated by the platform's maker, a standard, or a man page    |
| **SOURCE**     | Read in the source code of the kernel or tool, with the file |
| **REASONED**   | An inference from the above, not observed                    |
| **UNKNOWN**    | Could not be established; listed at the end                  |

Nothing is OBSERVED yet. The first box on a rig should change that, and this
document is where it gets recorded.

## The one rule

**The map sends nothing.** Its inputs are:

1. What the lighting listener and the media watcher already parse. Each now
   keeps the sender's address of every packet it parses (`HeardHosts`,
   `server/src/netmap/hosts.ts`), from the same message handlers, on the same
   receive-only sockets. No socket was added, so the announcer's watcher list
   is unchanged.
2. Reads of local tables: files under `/proc` and `/sys`, and a fixed list of
   commands that only read.

`server/test/netmapReadOnly.test.ts` holds the directory to that: no socket
module, no `fetch`, and exactly these commands:

| Command                                                | Platform       | Why it is a read                                                                                                                                                                 |
| ------------------------------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `arp -an`                                              | macOS          | Reads the table through a routing sysctl (SOURCE, `network_cmds` `arp.c`). `-n` matters: without it every address is looked up in DNS, which is sending.                         |
| `arp -a`                                               | Windows        | Windows `arp` never resolves names (DOCUMENTED).                                                                                                                                 |
| `netstat -rn -f inet`, `route print -4`                | macOS, Windows | The default route, from the routing table; `-n` keeps netstat numeric.                                                                                                           |
| `networkctl lldp --json=short`                         | Linux          | Asks systemd-networkd what it already heard; the varlink method has no polkit check (SOURCE, `networkd-manager-varlink.c`). networkd never sends LLDP unless `EmitLLDP=` is set. |
| `iw dev <wlan> scan dump`, `iw dev <wlan> survey dump` | Linux          | nl80211 `GET_SCAN` and `GET_SURVEY` read the kernel's cache and carry no admin flag (SOURCE, `nl80211.c`). `iw … scan` without `dump` starts a scan, and is never run.           |
| `nmcli -t … dev wifi list ifname <wlan> --rescan no`   | Linux          | Reads NetworkManager's list over D-Bus. Without `--rescan no`, nmcli starts a scan when its list is older than 30 s (SOURCE, `nmcli.xml`).                                       |

## The privacy rule

**Phones and laptops are a count, never a list.** The privacy page promises
crew devices are counted, not identified, and the map keeps to it:

- On the crew network the box names only the router (the default route's
  gateway). Every other host in its neighbour table is a number.
- A show network that shares the crew adapter lists only what spoke a show
  protocol there; everything else joins the crew count.
- A host heard only over plain mDNS is listed by address, never by the name
  it announced: that name is "Sams-iPhone" as often as a stage box. Dante,
  NDI and NMOS devices are named by their service instance, as the audit
  already does. The watcher does not even keep mDNS host names.
- Nothing the map reads is stored. Each request reads the tables afresh (at
  most once every 5 s), and `HeardHosts` lives in memory like the rosters it
  sits beside.

## Where each fact comes from

### Devices the watchers heard

- **Address of every sender** of a parsed Art-Net, sACN, mDNS, PTP or SAP
  packet: the UDP source address the socket reports. REASONED that this is
  the device's own address: a device behind NAT, or a multicast relayed by a
  router, would show the relay's.
- **sACN consoles** are joined to their address by CID: the listener notes
  the CID with each sender, so a desk heard before the box knew its address
  still appears, by name, with no address.
- **`HeardHosts` is bounded at 1024 addresses** and refuses new ones when
  full rather than evicting, the same choice as the mDNS roster: a flood of
  spoofed senders must not empty the list of real devices. The map says how
  many were refused.

### When a device is "gone quiet"

Each source has its own window (`QUIET_MS` in `server/src/netmap/map.ts`),
all **REASONED**, none measured:

| Source                 | Window | Why                                                                                      |
| ---------------------- | ------ | ---------------------------------------------------------------------------------------- |
| Art-Net, sACN, PTP     | 30 s   | Data and clock messages repeat every second or faster; a node answers each console poll. |
| Dante, NDI, NMOS, mDNS | 10 min | Announcements repeat on the order of minutes.                                            |
| SAP                    | 10 min | Announcement intervals of 30 s to 5 min are common.                                      |

An Art-Net node answers polls, not the box: a rig with no console polling
will show its nodes as quiet. That is true, and it is why the row says
"Gone quiet" and when, rather than "fault".

An LED processor takes the video watcher's own verdict, poll by poll,
rather than a window here.

### The neighbour table

- Linux `/proc/net/arp` (SOURCE, proc(5)); macOS `arp -an`; Windows `arp -a`.
- It holds the hosts the box has exchanged traffic with and the hosts that
  ARPed for it, never a census (SOURCE, `net/ipv4/arp.c`). An incomplete
  entry (flags without 0x2) is a host the box tried to reach and got no
  answer from: shown as **Not answering** on a show network.

### The default gateway

Linux `/proc/net/route`, little-endian hex; macOS `netstat -rn -f inet`
(numeric, so no lookups); Windows `route print -4`.

### The IGMP querier

Linux `/proc/net/igmp`, the Querier column per adapter (SOURCE,
`net/ipv4/igmp.c`). `V1` or `V2` means a querier of that version was heard in
the last QRV × QI + QRI, about 260 s at the defaults. `V3` means none of
those was: either an IGMPv3 querier or none at all, and the file cannot say
which. So the map treats only `V1` and `V2` as evidence and says so in
words. Not read on macOS or Windows (UNKNOWN whether they expose it).

### The switch port

LLDP that systemd-networkd heard, on links it manages; it listens by default
(`LLDP=routers-only`, which includes bridges, so switches are heard; SOURCE,
`systemd.network.xml`). The JSON field names (`Neighbors`, `InterfaceName`,
`SystemName`, `PortID`, `PortDescription`, `ChassisID`) are **REASONED** from
systemd's source and not yet seen from a real `networkctl`; the parser
returns nothing rather than guessing when they differ. A box on
NetworkManager without networkd shows no switch port.

### Adapters

`os.networkInterfaces()` for address, netmask and MAC; on Linux,
`/sys/class/net/<name>/speed` and `operstate` for link speed and state, and
`/sys/class/net/<name>/wireless` to find the Wi-Fi radios. A driver that
reports no speed (most Wi-Fi) leaves it blank.

### Wi-Fi around the box

Linux only, from the system's own scans: the box never starts one.

- `iw` first: dBm, frequency, SSID, security, and each access point's BSS
  Load element (station count, channel utilisation out of 255; DOCUMENTED,
  IEEE 802.11 element 11). Then `survey dump` for the share of time the
  radio found each channel busy, and its noise.
- NetworkManager's list as a fallback: a percentage, no dBm and no load.
- The BSSID is sent to the page as its last three octets only, enough to
  tell access points apart.
- The crew Wi-Fi is marked by the name an admin typed at setup.
- **UNKNOWN:** how often a connected Linux box's own scans refresh the list,
  which decides how fresh it is, and which drivers report survey data for
  channels other than their own.
- **Mac:** the network names need Location Services granted to the menu-bar
  app (DOCUMENTED, third-party reports; Apple's own pages do not state it),
  and Node cannot call CoreWLAN. Not built; the map says so.
- **Windows 11 24H2 and later:** every list and scan call fails without
  location consent (DOCUMENTED, Microsoft). Not built; the map says so.

## What the map cannot see

It is a lower bound, and the view says so on every load:

- a device that never announces itself and never talks to the box;
- a lighting controller that only unicasts;
- which port of which switch any device other than the box is on, and the
  link between two switches: those need the switches' own tables, over SNMP,
  with the owner's credentials (stage 5);
- which access point a crew phone is on, or its signal: that is the Android
  app's half of stage 3, and never possible on an iPhone or in a browser.

## Still to settle on a rig

1. A capture alongside the map, showing it sent nothing new (the "done
   when" of stage 2).
2. `networkctl lldp --json=short` output from a real switch.
3. Whether the quiet windows above match what real Dante and SAP devices do.
4. The iw cache's age on a connected Linux box, and survey support on the
   radios crewbox ships with.
