import { describe, expect, it } from 'vitest'
import type { ProcessorReading, ProcessorStatus, VideoProcessor } from '@crewbox/shared'
import {
  STATE_LABELS,
  ago,
  byUrgency,
  detailOf,
  readPathLabel,
  shouldSuggestSnmp,
} from '../src/modules/video/model/format.ts'

/**
 * What the LED pane says about a wall.
 *
 * The rule these tests exist to hold is that the row never claims more than
 * the box actually read. Protocol facts here are unverified against hardware
 * — nobody has had a NovaStar processor in front of this code — so a pane
 * that fills gaps with plausible numbers would be turning "we don't know"
 * into "it's fine", at two in the morning, on a screen somebody is making a
 * decision from.
 */

const reading = (over: Partial<ProcessorReading> = {}): ProcessorReading => ({
  at: 1_000,
  readPath: 'http',
  cabinets: [],
  inputs: [],
  errors: [],
  ...over,
})

const processor = (over: Partial<VideoProcessor> = {}): VideoProcessor => ({
  id: 'p1',
  name: 'Main wall',
  host: '10.0.30.11',
  monitored: true,
  addedBy: 'Alex',
  addedAt: 0,
  source: 'manual',
  ...over,
})

const status = (over: Partial<ProcessorStatus> = {}): ProcessorStatus => ({
  processor: processor(),
  state: 'watching',
  health: 'ok',
  summary: 'fine',
  reading: null,
  lastHeard: null,
  misses: 0,
  ...over,
})

describe('the detail line', () => {
  it('is empty when there is no reading, rather than reassuring', () => {
    expect(detailOf(null)).toBe('')
    expect(detailOf(reading())).toBe('')
  })

  it('counts cabinets, and says how many are missing', () => {
    expect(
      detailOf(
        reading({
          cabinets: [
            { id: 'A1', online: true },
            { id: 'A2', online: false },
          ],
        })
      )
    ).toBe('1/2 cabinets online')
  })

  it('reports the hottest cabinet, not an average', () => {
    // An average hides the one panel in the sun, which is the only one worth
    // walking over to look at.
    const detail = detailOf(
      reading({
        cabinets: [
          { id: 'A1', online: true, temperature: 38 },
          { id: 'A2', online: true, temperature: 61 },
        ],
      })
    )
    expect(detail).toContain('hottest 61°C')
  })

  it('says "abnormal" for cards read over SNMP, never a temperature', () => {
    // SNMP gives receiving cards a normal/abnormal status and no degrees.
    // Printing a number here would be inventing one.
    const detail = detailOf(
      reading({
        readPath: 'snmp',
        cabinets: [
          { id: '1.1.1', online: true, tempStatus: 'normal' },
          { id: '1.1.2', online: true, tempStatus: 'abnormal' },
        ],
      })
    )
    expect(detail).toContain('1 reporting abnormal')
    expect(detail).not.toContain('°C')
  })

  it('prefers a fan fault to a fan speed', () => {
    expect(detailOf(reading({ fanFault: true, fanSpeed: 55 }))).toContain('a fan is abnormal')
  })

  it('mentions dark inputs and stays quiet about spare connectors', () => {
    const dark = detailOf(
      reading({
        inputs: [
          { id: '1', signal: 'no-signal' },
          { id: '2', signal: 'not-connected' },
        ],
      })
    )
    expect(dark).toBe('1 input with no signal')

    const idle = detailOf(reading({ inputs: [{ id: '2', signal: 'not-connected' }] }))
    // Three spare connectors on a processor is not three faults.
    expect(idle).toBe('')
  })

  it('leaves out a brightness the controller never gave', () => {
    expect(detailOf(reading({ cabinets: [{ id: 'A1', online: true }] }))).not.toContain('%')
  })
})

describe('how it is being read', () => {
  it('names the interface, because they do not carry the same information', () => {
    expect(readPathLabel(reading({ readPath: 'snmp' }))).toBe('over SNMP')
    expect(readPathLabel(reading({ readPath: 'http' }))).toBe('over the HTTP API')
    expect(readPathLabel(null)).toBe('')
  })

  it('suggests SNMP only when the controller said it was off', () => {
    // And never offers to switch it on: that is a write, and this module has
    // no way to make one.
    expect(shouldSuggestSnmp(status({ reading: reading({ snmpEnabled: false }) }))).toBe(true)
    expect(shouldSuggestSnmp(status({ reading: reading({ snmpEnabled: true }) }))).toBe(false)
    // Undefined means we could not tell, which is not the same as "off".
    expect(shouldSuggestSnmp(status({ reading: reading() }))).toBe(false)
    expect(shouldSuggestSnmp(status({ reading: reading({ readPath: 'snmp' }) }))).toBe(false)
  })
})

describe('ordering', () => {
  it('puts faults first and unwatched processors last', () => {
    const rows = [
      status({ processor: processor({ id: 'a', name: 'A' }), health: 'ok' }),
      status({
        processor: processor({ id: 'b', name: 'B', monitored: false }),
        state: 'listed',
        health: 'unknown',
      }),
      status({ processor: processor({ id: 'c', name: 'C' }), health: 'fault' }),
      status({ processor: processor({ id: 'd', name: 'D' }), health: 'warn' }),
    ]
    expect([...rows].sort(byUrgency).map((r) => r.processor.name)).toEqual(['C', 'D', 'A', 'B'])
  })

  it('never makes an unwatched processor urgent', () => {
    // It has no readings behind it, so whatever it grades to is not news.
    const listed = status({
      processor: processor({ monitored: false, name: 'Spare' }),
      state: 'listed',
      health: 'fault',
    })
    const watched = status({ processor: processor({ name: 'Main' }), health: 'ok' })
    expect([listed, watched].sort(byUrgency).map((r) => r.processor.name)).toEqual([
      'Main',
      'Spare',
    ])
  })
})

describe('wording', () => {
  it('says "not watched" rather than anything that sounds like a fault', () => {
    // The resting state is normal, and a red-sounding word here would train
    // people to ignore the ones that matter.
    expect(STATE_LABELS.listed).toBe('Not watched')
  })

  it('says never when the box has never heard from it', () => {
    expect(ago(null, 1_000)).toBe('never')
    expect(ago(1_000, 1_000)).toBe('just now')
    expect(ago(1_000, 1_000 + 4 * 60_000)).toBe('4 min ago')
    expect(ago(1_000, 1_000 + 3 * 60 * 60_000)).toBe('3 h ago')
  })
})
