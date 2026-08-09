/**
 * The local DNS entry that makes a box's certificate usable on site.
 *
 * A certificate is only worth having if crew phones reach the box *by the
 * name on it* — otherwise the browser refuses, and with it the microphone and
 * the installable app. That means the name has to resolve, on the event
 * network, to the box's LAN address.
 *
 * It cannot come from public DNS, for two reasons that both bite:
 *
 *  - A festival network has no uplink, so a phone cannot ask a public
 *    resolver anything. The record could be perfect and still unreachable.
 *  - Many routers refuse public answers pointing at private addresses (DNS
 *    rebinding protection), so even a site with internet often won't resolve
 *    it.
 *
 * A wildcard on the domain makes it worse again: every name already resolves,
 * to whatever the wildcard points at, so crew following the name land on a
 * web host instead of the box.
 *
 * So the answer is a local override on the network's own resolver. The box
 * knows both halves — its address and its certificate's name — so it can
 * write the config rather than describe it.
 *
 * The same file carries a second, optional block: the connectivity-probe
 * hostnames every phone OS fetches to decide whether a network has internet.
 * Point those at the box too and phones stop declaring the crew Wi-Fi dead —
 * which on iOS means they stop silently moving to cellular and losing the
 * box entirely. See captive.ts for what answers them.
 */

import { PROBE_HOSTS } from './captive.ts'

export interface DnsPlan {
  hostname: string
  address: string
  /** dnsmasq: OpenWRT, Pi-hole, most Linux routers, and the deploy/ config. */
  dnsmasq: string
  /** A hosts file, for one laptop that needs to work before the router does. */
  hosts: string
  /** BIND-style zone line, for a venue that runs its own resolver. */
  zone: string
  /**
   * The other half of the "phones stay on the crew Wi-Fi" fix: the hostnames
   * each OS fetches to decide whether a network has internet, pointed at the
   * box so its responder can answer them (see captive.ts).
   */
  probes: {
    hostnames: readonly string[]
    dnsmasq: string
    hosts: string
  }
}

export function dnsPlan(hostname: string, address: string): DnsPlan {
  return {
    hostname,
    address,
    // address=/name/ip matches the name and everything under it, and beats
    // any upstream answer — which is the point, since the upstream will
    // usually answer with a wildcard.
    dnsmasq: `address=/${hostname}/${address}`,
    hosts: `${address}\t${hostname}`,
    zone: `${hostname}.\tIN\tA\t${address}`,
    probes: {
      hostnames: PROBE_HOSTS,
      dnsmasq: PROBE_HOSTS.map((host) => `address=/${host}/${address}`).join('\n'),
      hosts: PROBE_HOSTS.map((host) => `${address}\t${host}`).join('\n'),
    },
  }
}

/** A file an admin can drop straight onto a router, comments and all. */
export function dnsConfigFile(plan: DnsPlan): string {
  return `# Crewbox — local DNS for ${plan.hostname}
#
# Point ${plan.hostname} at the crew box on this network, so phones reach it
# by the name on its certificate. Without this the certificate goes unused:
# browsers refuse the name, and with it the microphone and "add to home
# screen".
#
# This has to be a LOCAL override. Public DNS cannot do it — a festival
# network has no uplink to ask, and routers commonly refuse public answers
# that point at private addresses.

# --- OpenWRT, Pi-hole, dnsmasq --------------------------------------------
# Save as /etc/dnsmasq.d/crewbox.conf (OpenWRT: /etc/dnsmasq.d/), then
# restart dnsmasq. Make sure DHCP hands out this router as the DNS server.
${plan.dnsmasq}

# --- A single machine, before the router is set up ------------------------
# Append to /etc/hosts (macOS and Linux), or
# C:\\Windows\\System32\\drivers\\etc\\hosts on Windows.
${plan.hosts}

# --- A venue running its own BIND/zone file -------------------------------
${plan.zone}

# Check it worked from a phone on the crew network: the join page should load
# at https://${plan.hostname} with no certificate warning.


# ==========================================================================
# OPTIONAL — stop phones deciding this network is dead
# ==========================================================================
#
# Every phone fetches one fixed URL when it joins a Wi-Fi network to decide
# whether that network "has internet". With no uplink they all fail, and iOS
# does not just draw a warning: it drops the Wi-Fi indicator and moves
# traffic to the mobile network. The crew box is on a private address only
# reachable over the Wi-Fi the phone has just abandoned, so crewbox sits on
# "Connecting" while the phone insists it is online.
#
# Adding these lines points those probes at the box, which answers them. The
# box has to be running its probe responder for this to help — it listens on
# port 80 and says so in the admin panel's readiness list.
#
# The trade, stated plainly: phones will stop warning that this network has
# no internet, because as far as they can tell it now has. That is the
# intent. Crew on this network are talking to the box, not browsing.
#
# Only hostnames that exist to be probed are listed. www.google.com and
# www.gstatic.com are deliberately absent — they serve real content too, and
# redirecting them breaks pages instead of fixing a network.

# --- dnsmasq (OpenWRT, Pi-hole) -------------------------------------------
${plan.probes.dnsmasq}

# --- hosts file -----------------------------------------------------------
${plan.probes.hosts}

# Check it worked: join the crew Wi-Fi on an iPhone and confirm the Wi-Fi
# icon stays in the status bar, with no "no internet connection" alert.
`
}
