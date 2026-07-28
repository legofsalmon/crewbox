import { useMemo } from 'react'
import { useStore } from '../../../store.ts'
import { fixtureLabel } from '../model/fixtures'
import { channelReadout } from '../model/gdtfLive'
import type { Fixture, FixtureType } from '../model/types'
import styles from './FixtureChannels.module.scss'

/**
 * What the desk is actually sending one fixture, channel by channel.
 *
 * This is the question someone has with a torch in their teeth at the top of
 * a ladder: the head is dark, is that because the dimmer is out, the shutter
 * is closed, or nothing is arriving at all? A level meter can't tell those
 * apart. A GDTF profile can.
 *
 * Only fixtures whose type carries a profile get one — which today means
 * anything that came in from an MVR. Everything else shows nothing rather
 * than a list of numbered channels with no meaning attached.
 */

/**
 * "ColorAdd_R" → "Colour Add R", "Shutter1" → "Shutter 1".
 *
 * GDTF attribute names are enumerated with a trailing digit — Shutter1,
 * Color1, Gobo2 — and run together otherwise. Splitting both is the whole
 * job; nothing here tries to be clever about renaming them, because the
 * GDTF name is what a profile editor and a desk will both call it.
 */
const prettyAttribute = (attribute: string): string =>
  attribute
    .replace(/^Color(Add|Sub|RGB)_/, 'Colour $1 ')
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^Color/, 'Colour')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')

export default function FixtureChannels({
  fixture,
  customTypes,
}: {
  fixture: Fixture
  customTypes: FixtureType[]
}) {
  const levels = useStore((s) => (s.dmx.listening ? s.dmx.levels : null))
  const readings = useMemo(
    () => channelReadout(fixture, customTypes, levels ?? new Map()),
    [fixture, customTypes, levels]
  )

  if (readings.length === 0) return null

  // More than one geometry means a multi-cell fixture, and then the cell is
  // the difference between four identical-looking rows.
  const cells = new Set(readings.map((r) => r.geometry))
  const showGeometry = cells.size > 1

  return (
    <div className={styles.panel}>
      <h3 className={styles.title}>
        {fixtureLabel(fixture)} · {fixture.mode}
        {!levels && <span className={styles.idle}>not watching levels</span>}
      </h3>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Addr</th>
            <th scope="col">Channel</th>
            <th scope="col">Value</th>
            <th scope="col" className={styles.raw}>
              DMX
            </th>
          </tr>
        </thead>
        <tbody>
          {readings.map((reading, index) => (
            <tr key={`${reading.attribute}-${reading.geometry}-${index}`}>
              <td className={styles.address}>
                {reading.addresses
                  ? reading.addresses.join('/')
                  : /* A fixture patched across several DMX breaks has a
                       second start address this plot has nowhere to put.
                       Saying so beats reading the wrong slot. */
                    '—'}
              </td>
              <td>
                {prettyAttribute(reading.attribute)}
                {showGeometry && reading.geometry && (
                  <span className={styles.geometry}>{reading.geometry}</span>
                )}
              </td>
              <td className={styles.value}>
                {reading.colour && (
                  <span
                    className={styles.swatch}
                    style={{ background: reading.colour }}
                    aria-hidden="true"
                  />
                )}
                {reading.state && <span className={styles.state}>{reading.state}</span>}
                {reading.value}
                {!reading.state && !reading.value && reading.addresses && (
                  <span className={styles.idle}>—</span>
                )}
              </td>
              <td className={styles.raw}>{reading.raw ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
