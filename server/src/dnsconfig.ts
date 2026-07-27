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
 */

export interface DnsPlan {
  hostname: string
  address: string
  /** dnsmasq: OpenWRT, Pi-hole, most Linux routers, and the deploy/ config. */
  dnsmasq: string
  /** A hosts file, for one laptop that needs to work before the router does. */
  hosts: string
  /** BIND-style zone line, for a venue that runs its own resolver. */
  zone: string
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
`
}
