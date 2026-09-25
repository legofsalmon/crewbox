import { networkInterfaces } from 'node:os'

/**
 * Where the docs run's fake LED processor listens, and what the LED walls
 * shot types into the Address field.
 *
 * Not loopback: the video module refuses 127.x as a processor address (it is
 * not one processor on a video network, and the store's unicast rule says so),
 * so a simulator on 127.0.0.1 left the shot stuck on the add form. This
 * machine's own first LAN address is a real unicast address the box accepts,
 * and a connection to it never leaves the machine.
 *
 * Read by both the config and the spec, which run in different processes, so
 * it is computed rather than handed over; both see the same interfaces.
 */
export function wallAddress(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const nic of list ?? []) {
      if (nic.family === 'IPv4' && !nic.internal) return nic.address
    }
  }
  throw new Error('the LED walls shot needs a non-loopback IPv4 address on this machine')
}
