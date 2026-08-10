import { describe, expect, it } from 'vitest'
import { parsePmset, readLinuxPower } from '../src/power.ts'

/**
 * Reading the machine's power state.
 *
 * Tested through injected text and an injected filesystem because CI runners
 * have no battery, and a check that only runs on hardware is one that never
 * runs — which is exactly how this row would come to report something wrong
 * on the one night it matters.
 */

describe('macOS pmset', () => {
  it('reads a laptop on mains', () => {
    const reading = parsePmset(
      "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1234)\t100%; charged; 0:00 remaining present: true\n"
    )
    expect(reading).toEqual({ onMains: true, percent: 100 })
  })

  it('reads a laptop on battery, with the estimate', () => {
    const reading = parsePmset(
      "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1234)\t64%; discharging; 2:10 remaining present: true\n"
    )
    expect(reading).toEqual({ onMains: false, percent: 64, minutesLeft: 130 })
  })

  it('treats charging as mains — what matters is power coming in', () => {
    const reading = parsePmset(
      "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1234)\t41%; charging; 1:05 remaining present: true\n"
    )
    expect(reading?.onMains).toBe(true)
  })

  it('ignores the 0:00 macOS prints while it works the estimate out', () => {
    // Reporting "0 minutes left" there would be a false alarm of the worst
    // kind: the urgent state, on a box that is fine.
    const reading = parsePmset(
      "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1234)\t88%; discharging; 0:00 remaining present: true\n"
    )
    expect(reading?.minutesLeft).toBeUndefined()
    expect(reading?.percent).toBe(88)
  })

  it('says nothing at all about a machine with no battery', () => {
    // A Mac mini has only ever had mains. There is no useful row to draw.
    expect(parsePmset("Now drawing from 'AC Power'\n")).toBeNull()
  })
})

describe('Linux /sys/class/power_supply', () => {
  const fs = (files: Record<string, string>) => ({
    list: () => [...new Set(Object.keys(files).map((p) => p.split('/').slice(0, -1).join('/')))],
    read: (path: string) => files[path] ?? null,
  })

  it('reads a laptop discharging', () => {
    const { list, read } = fs({
      'BAT0/type': 'Battery\n',
      'BAT0/status': 'Discharging\n',
      'BAT0/capacity': '57\n',
      'BAT0/energy_now': '30000000\n',
      'BAT0/power_now': '10000000\n',
      'AC/type': 'Mains\n',
      'AC/online': '0\n',
    })
    expect(readLinuxPower(list, read)).toEqual({ onMains: false, percent: 57, minutesLeft: 180 })
  })

  it('believes the battery over the adapter', () => {
    // A plugged-in adapter still reads online=1 when it is not actually
    // delivering — a dead brick, or a laptop charger too small for the load.
    // The battery's own status is the better evidence.
    const { list, read } = fs({
      'BAT0/type': 'Battery\n',
      'BAT0/status': 'Discharging\n',
      'BAT0/capacity': '80\n',
      'AC/type': 'Mains\n',
      'AC/online': '1\n',
    })
    expect(readLinuxPower(list, read)?.onMains).toBe(false)
  })

  it('says nothing about a machine with no battery', () => {
    const { list, read } = fs({ 'AC/type': 'Mains\n', 'AC/online': '1\n' })
    expect(readLinuxPower(list, read)).toBeNull()
  })

  it('survives a kernel that exposes almost nothing', () => {
    // Plenty of machines have a battery node and little else in it.
    const { list, read } = fs({ 'BAT0/type': 'Battery\n' })
    const reading = readLinuxPower(list, read)
    expect(reading).not.toBeNull()
    expect(reading?.percent).toBeUndefined()
  })
})
