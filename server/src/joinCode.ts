import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'

/**
 * What the box's join QR says (docs/DISCOVERY.md, "The join QR"): the box's
 * address, the event PIN where whoever reads it may be shown it, and the
 * event's ID and public key, as `/api/config` gives them.
 *
 * A phone's own camera opens it in the browser, where `pin` fills in the join
 * form and the rest goes unread. The apps' scanner reads all of it
 * (web/src/lib/joinCode.ts) and checks the box at that address against the
 * key before the PIN goes to it, so a poster proves its own box. One printed
 * before the QR carried the key still joins, unchecked, as a typed address
 * does, and so does one that names no event ({@link namesEventAt}).
 *
 * The console QR and `/connect` both come from here, so they can't disagree.
 */
export function joinCode(
  base: string,
  { pin, event }: { pin?: string; event?: { id: string; key: string } }
): string {
  const query = new URLSearchParams()
  if (pin) query.set('pin', pin)
  if (event) {
    query.set('event', event.id)
    query.set('key', event.key)
  }
  return `${base}/?${query}`
}

/**
 * Whether a join QR for `base` names the event: everywhere but at an IP
 * address that isn't one of this box's own, as a port forward's.
 *
 * The box signs for an address only where a connection arrives at it
 * (hostToSign in identity.ts), and the apps refuse a poster whose box won't
 * sign for the IP address it gives, since anything could say it won't. So a
 * QR for a port forward's address names no event, and joins as a poster
 * printed before the QR named one does. By a name, a box signs only with a
 * certificate for it, and the apps take its sign-in to check instead.
 */
export function namesEventAt(
  base: string,
  interfaces: Record<string, ReadonlyArray<{ address: string }> | undefined> = networkInterfaces()
): boolean {
  const host = new URL(base).hostname
  if (!isIP(host.replace(/^\[(.*)\]$/, '$1'))) return true
  return Object.values(interfaces).some((addresses) =>
    (addresses ?? []).some(({ address }) => hostOf(address) === host)
  )
}

/** An interface's address as a parsed URL writes it: IPv6 in brackets, shortest form. */
function hostOf(address: string): string | undefined {
  const plain = address.replace(/%.*$/, '')
  const literal = isIP(plain) === 6 ? `[${plain}]` : plain
  try {
    return new URL(`http://${literal}/`).hostname
  } catch {
    return undefined
  }
}
