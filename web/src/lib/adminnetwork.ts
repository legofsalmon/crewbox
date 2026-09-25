import type { AdminNetwork, AnnounceStatus } from './api.ts'

/**
 * Two questions the Networks form got wrong by reading only what was saved.
 *
 * The panel edits saved settings, but the box runs on the environment where
 * one is set. On a box configured through environment variables — which is
 * every box the deploy scripts set up — those two are different, and the
 * form drew the saved answer.
 */

/**
 * Which lighting mode this box is actually listening with.
 *
 * `CREWBOX_DMX=sacn` with nothing ever saved through the panel leaves the
 * saved mode empty, so the form concluded lighting was off and hid the
 * adapter and universes fields entirely. Those two are not pinned by the
 * environment, and on such a box they are the only two an operator can set —
 * so the fields that mattered were exactly the ones that disappeared.
 */
export function listeningMode(network: AdminNetwork, chosen: string): string {
  if (!network.fromEnv.dmxMode) return chosen
  // An older box sends no `effective`; its saved value is the best there is.
  return network.effective?.dmxMode ?? chosen
}

/**
 * Is the selected adapter absent from the list the box can see?
 *
 * A USB-to-Ethernet dongle left in the van, or a Wi-Fi network not joined
 * yet. The select then had no option matching its value and fell back to
 * showing the blank one — so the panel said "All networks" while the box was
 * pinned to an adapter that is not there, and choosing the blank option
 * registered as no change and saved nothing.
 */
export function adapterMissing(adapters: readonly { address: string }[], current: string): boolean {
  if (!current) return false
  return !adapters.some((a) => a.address === current)
}

/**
 * One line on whether the apps can find this box, for under the setting.
 *
 * The box writes the reasons, because it is the one that knows which adapter
 * and which listener; this adds the words for the states that need none.
 */
export function describeAnnounce(status: AnnounceStatus): string {
  const where = status.address ? ` on ${status.address}` : ''
  switch (status.state) {
    case 'announcing':
      return `Announcing as “${status.name ?? 'crewbox'}”${where}. The apps on the crew network list it without being given the address.`
    case 'starting':
      return `Starting to announce${where}.`
    case 'off':
      return 'Off. Phones need the address or the QR code to find this box.'
    case 'quiet':
    case 'failed':
      return status.reason ?? 'Not announcing.'
  }
}
