/**
 * The rule that lets an unprivileged box answer on port 80 anyway.
 *
 * Phones send their "does this network have internet" checks to port 80, and
 * no ordinary user may bind a port below 1024. A double-clicked Crewbox.app
 * runs as whoever launched it, so on macOS — the platform most boxes run on —
 * the responder never gets the port it needs.
 *
 * The obvious answer, running the box with sudo, is the wrong one: it leaves
 * a process that accepts file uploads, serves untrusted crew traffic and runs
 * a voice server at root for the whole event, to hold one socket. The right
 * answer is to leave the box unprivileged and move the packets instead. The
 * OS's own packet filter can rewrite the destination port of arriving traffic
 * before deciding which program receives it, so a phone connecting to port 80
 * lands on the box's unprivileged port without knowing anything changed.
 *
 * That is a one-off `sudo` to load a rule, not a permanently elevated box.
 *
 * Generated rather than documented, for the same reason as the DNS config
 * (see dnsconfig.ts): the box already knows the adapter, the address and the
 * port, and every one of those typed wrong fails silently.
 */

export interface RedirectPlan {
  /** Adapter the crew network is on — the rule is scoped to it. */
  iface: string
  address: string
  /** Where the responder is actually listening. */
  port: number
  /** The macOS pf rule itself. */
  rule: string
  /** Load it now, until the next reboot. */
  load: string
  /** Undo it. */
  unload: string
  /** The Linux equivalent, for a box that can't be given the capability. */
  linux: string
}

export function redirectPlan(opts: { iface: string; address: string; port: number }): RedirectPlan {
  const { iface, address, port } = opts
  // `on <iface>` matters: without it the rule applies to every adapter,
  // including a lighting VLAN this box has no business touching.
  const rule = `rdr pass on ${iface} inet proto tcp from any to any port 80 -> ${address} port ${port}`
  return {
    iface,
    address,
    port,
    rule,
    load: `echo "${rule}" | sudo pfctl -ef -`,
    unload: 'sudo pfctl -d',
    linux: `sudo nft add rule inet nat prerouting iif ${iface} tcp dport 80 redirect to :${port}`,
  }
}

/** A file an admin can work through, comments and all. */
export function redirectConfigFile(plan: RedirectPlan): string {
  return `# Crewbox — send port 80 to the probe responder
#
# Phones decide whether a network "has internet" by fetching one fixed URL
# over plain HTTP on port 80. This box answers those checks, but it could not
# take port 80: only root may bind a port below 1024, and the box runs as
# whoever launched it.
#
# So it is listening on port ${plan.port} instead, and needs port 80 pointed at it.
#
# Running the box with sudo would also work and is a worse idea: it would
# leave a process handling file uploads and untrusted crew traffic at root
# for the whole event, to hold one socket. The rule below keeps the box
# unprivileged and moves the packets instead.

# --- macOS ----------------------------------------------------------------
# Loads now, lasts until the machine reboots.
${plan.load}

# Undo it:
${plan.unload}
#
# Two things worth knowing:
#  - pf does not redirect traffic the Mac sends to itself, so testing with
#    curl on this machine will fail even when the rule is working. Test from
#    a phone.
#  - This replaces whatever pf ruleset is loaded. On a stock Mac that is
#    nothing at all (pfctl -s info says Disabled). If you run a VPN that uses
#    pf, add the rule to its configuration instead of loading this one.

# --- macOS, surviving a reboot --------------------------------------------
# 1. Save the rule as /etc/pf.anchors/crewbox:
${plan.rule}
#
# 2. Add these two lines to /etc/pf.conf, after the existing rdr-anchor line:
# rdr-anchor "crewbox"
# load anchor "crewbox" from "/etc/pf.anchors/crewbox"
#
# 3. Enable it: sudo pfctl -f /etc/pf.conf -E

# --- Linux ----------------------------------------------------------------
# Prefer granting the binary the capability — then it takes port 80 directly
# and no redirect is needed at all:
# sudo setcap 'cap_net_bind_service=+ep' /path/to/crewbox
#
# Failing that:
${plan.linux}

# --- Or do it on the router -----------------------------------------------
# Any router that can port-forward will do: forward TCP 80 to ${plan.address}
# port ${plan.port}. That keeps every box on the network fixed at once, and needs
# nothing installed on this machine.

# Check it worked: join the crew Wi-Fi on an iPhone and confirm the Wi-Fi
# icon stays in the status bar. Do not test with curl from this machine.
`
}
