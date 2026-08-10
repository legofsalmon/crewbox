/**
 * Whether the machine holding up the whole crew's comms is on mains.
 *
 * A laptop is the commonest crewbox — it is what the runbook suggests for
 * trials, small rooms and the spare in the car — and a laptop nobody plugged
 * in takes chat, voice and every paperwork module down with it when it dies.
 * That failure arrives with no warning at all: the box is fine, then it is
 * gone, and the first anyone knows is crew phones sitting on "Connecting"
 * during a set.
 *
 * The OS already knows. This asks it, so the admin panel can say so hours
 * before it matters.
 *
 * Deliberately shells out rather than adding a dependency: this is two
 * commands on the two platforms a box actually runs on, and a native module
 * would have to be built for every target the single-file box ships to.
 * Windows is not covered — `Get-CimInstance Win32_Battery` means spawning
 * PowerShell, which is slow enough to be felt on every panel open, and a
 * Windows box is nearly always a desktop on mains. Nothing is reported there
 * rather than something guessed.
 */

import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface PowerReading {
  /** On wall power. False means the clock is running. */
  onMains: boolean
  /** Charge remaining, when the OS reports it. */
  percent?: number
  /** Minutes of battery left, when the OS is willing to estimate. */
  minutesLeft?: number
}

/**
 * macOS `pmset -g batt`, which looks like:
 *
 *   Now drawing from 'Battery Power'
 *    -InternalBattery-0 (id=1234)\t64%; discharging; 2:10 remaining present: true
 *
 * Returns null when there is no battery at all (a Mac mini, say) — there is
 * nothing useful to say about a machine that has only ever had mains.
 */
export function parsePmset(text: string): PowerReading | null {
  if (!/-InternalBattery/.test(text)) return null
  // Charging counts as mains: what matters is whether power is coming in.
  const onMains = /drawing from ['"]AC Power['"]/i.test(text)
  const percent = /(\d+)%/.exec(text)
  const time = /(\d+):(\d{2}) remaining/.exec(text)
  const reading: PowerReading = { onMains }
  if (percent?.[1]) reading.percent = Number(percent[1])
  // 0:00 is what pmset prints while it is still working the estimate out.
  // Reporting "0 minutes left" then would be a false alarm of the worst kind.
  if (time?.[1] && time[2]) {
    const minutes = Number(time[1]) * 60 + Number(time[2])
    if (minutes > 0) reading.minutesLeft = minutes
  }
  return reading
}

/**
 * Linux, from /sys/class/power_supply. Injectable so the parsing is tested
 * without a battery — CI runners have none, and a check that only runs on
 * hardware is a check that is never run.
 */
export function readLinuxPower(
  list: () => string[],
  read: (path: string) => string | null
): PowerReading | null {
  const supplies = list()
  let battery: string | undefined
  let mains: boolean | undefined
  for (const name of supplies) {
    const type = read(join(name, 'type'))?.trim()
    if (type === 'Battery' && !battery) battery = name
    if (type === 'Mains') {
      const online = read(join(name, 'online'))?.trim()
      // Any mains adapter reporting online is enough.
      if (online === '1') mains = true
      else if (mains === undefined) mains = false
    }
  }
  if (!battery) return null

  const status = read(join(battery, 'status'))?.trim()
  // The battery's own status is better evidence than the adapter's: a plugged
  // -in adapter that is not actually delivering still reads online=1.
  const onMains =
    status === 'Charging' || status === 'Full' ? true : status === 'Discharging' ? false : mains

  const reading: PowerReading = { onMains: onMains ?? true }
  const capacity = read(join(battery, 'capacity'))?.trim()
  if (capacity && /^\d+$/.test(capacity)) reading.percent = Number(capacity)

  // energy_now/power_now is µWh over µW — hours. Absent on many machines, and
  // power_now is 0 the moment the load settles, so this stays optional.
  const energy = Number(read(join(battery, 'energy_now'))?.trim())
  const power = Number(read(join(battery, 'power_now'))?.trim())
  if (!reading.onMains && Number.isFinite(energy) && Number.isFinite(power) && power > 0) {
    reading.minutesLeft = Math.round((energy / power) * 60)
  }
  return reading
}

const SYS_POWER = '/sys/class/power_supply'

/** Read /sys, tolerating every file in it being absent or unreadable. */
function linuxPower(): PowerReading | null {
  if (!existsSync(SYS_POWER)) return null
  return readLinuxPower(
    () => {
      try {
        return readdirSync(SYS_POWER).map((name) => join(SYS_POWER, name))
      } catch {
        return []
      }
    },
    (path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    }
  )
}

/**
 * Ask this machine about its power, or return null when there is nothing to
 * say. Never throws and never hangs: a panel that stalled on a wedged
 * `pmset` would be worse than one that omits a row.
 */
export function readPower(): Promise<PowerReading | null> {
  if (process.platform === 'linux') return Promise.resolve(linuxPower())
  if (process.platform !== 'darwin') return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile('/usr/bin/pmset', ['-g', 'batt'], { timeout: 2000 }, (err, stdout) => {
      resolve(err ? null : parsePmset(stdout))
    })
  })
}
