import { spawn, type ChildProcess } from 'node:child_process'

/**
 * Keep a laptop box awake.
 *
 * A Mac mini or an old MacBook is a very plausible crew box, and the default
 * energy settings will put it to sleep — taking chat, voice and the patch
 * sheets down with it, usually about twenty minutes after the last person
 * touched the machine, which on site is exactly when nobody is looking at it.
 * Closing the lid does the same.
 *
 * `caffeinate -w <pid>` ties the assertion to this process, so it lifts on
 * exit even if the box is killed rather than shut down cleanly. The flags:
 * -d display, -i idle, -m disk, -s while on mains, -u user-active.
 *
 * Best effort by design. If caffeinate is missing or refuses, the box still
 * runs — it just might sleep, which is a worse box, not a broken one.
 */
export function preventSleep(log: { info: (msg: string) => void }): ChildProcess | null {
  if (process.platform !== 'darwin') return null
  try {
    const child = spawn('caffeinate', ['-dimsu', '-w', String(process.pid)], {
      stdio: 'ignore',
      detached: false,
    })
    child.on('error', () => {
      // Absent or blocked; nothing to do and nothing worth alarming about.
    })
    child.unref()
    log.info('macOS: sleep prevented while the box is running')
    return child
  } catch {
    return null
  }
}
