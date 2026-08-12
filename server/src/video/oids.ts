/**
 * NovaStar's COEX SNMP OID map.
 *
 * Provenance: *COEX SNMP Protocol Instructions V1.4.0*, official, transcribed
 * in novasun's `src/novasun/snmp.py` with its enumerations, sections 5.1.1 to
 * 5.1.9. **Not yet exercised against hardware** — nothing in this file is
 * marked OBSERVED because nothing has been observed.
 *
 * The numbers are copied from that transcription rather than re-derived from
 * the prose summary in `docs/read-only-monitoring.md`, whose identity list is
 * ordered loosely enough to put the role OID in two places. When two accounts
 * of a protocol fact disagree, take the one that carries its provenance.
 *
 * Applies to MX40 Pro, MX30, MX20, KU20, MX6000 Pro, CX40 Pro (VMP 1.4.0+).
 * VX4S and NovaPro UHD Jr have no SNMP agent at all — see
 * `docs/VIDEO_MONITORING.md`.
 *
 * `N`, `Y` and `M` are 1-based indices bounded by the matching count OID.
 * `at()` substitutes them in order of appearance.
 */

export const ENTERPRISE = '1.3.6.1.4.1.319'
export const CONTROLLER = `${ENTERPRISE}.10.10`
export const SCREEN = `${ENTERPRISE}.10.20`

/** Fill the N/Y/M placeholders, in the order they appear. */
export function at(oid: string, ...indices: number[]): string {
  const remaining = [...indices]
  const filled = oid.split('.').map((part) => {
    if (part !== 'N' && part !== 'Y' && part !== 'M') return part
    const next = remaining.shift()
    if (next === undefined) throw new Error(`${oid} needs more indices than ${indices.length}`)
    return String(next)
  })
  if (remaining.length > 0) throw new Error(`too many indices for ${oid}`)
  return filled.join('.')
}

// -- controller identity ------------------------------------------------------

export const CONTROLLER_TIME = `${CONTROLLER}.1.1`
export const CONTROLLER_MODEL = `${CONTROLLER}.1.2`
export const CONTROLLER_FIRMWARE = `${CONTROLLER}.1.3`
export const CONTROLLER_NAME = `${CONTROLLER}.1.4`
/** 0 primary, 1 backup. */
export const CONTROLLER_ROLE = `${CONTROLLER}.1.5`
export const CONTROLLER_SERIAL = `${CONTROLLER}.1.6`
export const CONTROLLER_MAC = `${CONTROLLER}.1.7`
export const CONTROLLER_IP = `${CONTROLLER}.1.8`

// -- controller health --------------------------------------------------------

export const TEMPERATURE_POINT_COUNT = `${CONTROLLER}.10.1`
export const TEMPERATURE_POINT_NAME = `${CONTROLLER}.10.2.N.1`
/** 0 normal, 1 abnormal. */
export const TEMPERATURE_POINT_STATUS = `${CONTROLLER}.10.2.N.2`
export const TEMPERATURE_POINT_VALUE = `${CONTROLLER}.10.2.N.3`

export const VOLTAGE_POINT_COUNT = `${CONTROLLER}.10.3`
export const VOLTAGE_POINT_STATUS = `${CONTROLLER}.10.4.N.2`

export const FAN_COUNT = `${CONTROLLER}.10.5`
export const FAN_NAME = `${CONTROLLER}.10.6.N.1`
/** 0 normal, 1 abnormal. */
export const FAN_STATUS = `${CONTROLLER}.10.6.N.2`

// -- output cards, ports and receiving cards ----------------------------------

/** 0 connected, 1 disconnected. */
export const OUTPUT_SLOT_STATUS = `${CONTROLLER}.30.2`
export const ETHERNET_PORT_COUNT = `${CONTROLLER}.30.5.N.1`
export const ETHERNET_PORT_SPEED = `${CONTROLLER}.30.5.N.2`
/** 0 normal, 1 abnormal. */
export const ETHERNET_PORT_STATUS = `${CONTROLLER}.30.5.N.3`
export const RECEIVING_CARDS_ONLINE = `${CONTROLLER}.30.5.N.4.Y.1`
/** 0 normal, 1 abnormal — a status, never a temperature in degrees. */
export const RECEIVING_CARD_TEMPERATURE_STATUS = `${CONTROLLER}.30.6.N.1.Y.1.M`
export const RECEIVING_CARD_VOLTAGE_STATUS = `${CONTROLLER}.30.6.N.1.Y.2.M`

// -- input cards and sources --------------------------------------------------

export const INPUT_SLOT_COUNT = `${CONTROLLER}.20.1`
export const INPUT_SOURCE_COUNT = `${CONTROLLER}.20.5.N.1`
/** 0 not inserted, 1 signal present, 2 inserted but no signal. */
export const INPUT_SOURCE_SIGNAL = `${CONTROLLER}.20.5.N.2.Y.1`
export const INPUT_SOURCE_TYPE = `${CONTROLLER}.20.5.N.2.Y.2`

// -- screens ------------------------------------------------------------------

export const SCREEN_COUNT = `${SCREEN}.1.1`
export const SCREEN_WIDTH = `${SCREEN}.1.2.N.2`
export const SCREEN_HEIGHT = `${SCREEN}.1.2.N.3`
/** Read/write at the controller. crewbox only ever reads it. */
export const SCREEN_BRIGHTNESS = `${SCREEN}.1.2.N.5`

/** 0 normal, 1 abnormal — the enumeration most status OIDs above use. */
export const NORMAL = 0
export const ABNORMAL = 1

/** Connector types, for `INPUT_SOURCE_TYPE`. */
export const SOURCE_TYPES: Record<number, string> = {
  0: 'DVI',
  1: 'Dual DVI',
  2: 'HDMI 1.4',
  3: 'HDMI 2.0',
  4: 'DP 1.1',
  5: 'DP 1.2',
  6: 'DP 1.4',
  7: '3G-SDI',
  8: '6G-SDI',
  9: '12G-SDI',
  10: 'PIP video',
  16: 'HDMI 1.3',
  17: 'HDMI 2.1',
  18: 'PCIe',
  19: 'SerDes',
  20: 'LVDS',
  21: 'V-by-One',
  22: 'ST 2110',
  224: 'internal source',
}

export const PROVENANCE =
  'COEX SNMP Protocol Instructions V1.4.0 (official, 2024), sections 5.1.1-5.1.9, ' +
  'via novasun src/novasun/snmp.py. Not yet exercised against hardware.'

/**
 * Bounds on how far a walk will index into a table.
 *
 * Every count comes off the wire, so a controller reporting 4 billion fans —
 * broken firmware, or something that is not a controller — must not turn one
 * poll into an unbounded packet storm on a show network. These are well above
 * any real COEX chassis.
 */
export const MAX_TEMPERATURE_POINTS = 16
export const MAX_FANS = 16
export const MAX_OUTPUT_CARDS = 8
export const MAX_PORTS_PER_CARD = 16
export const MAX_INPUT_CARDS = 8
export const MAX_SOURCES_PER_CARD = 16
export const MAX_SCREENS = 8
