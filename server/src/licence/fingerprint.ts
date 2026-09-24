import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/**
 * The raw platform id this box is known by — what goes ON THE WIRE, and the
 * "request code" an admin types into the account page for offline activation.
 *
 * Raw, never hashed. The service hashes what it is sent, and that hash is what
 * lands in the token; `check()` recomputes it from this same string. Hashing
 * here as well mints tokens bound to sha256(sha256(id)), which every later
 * check rejects as another machine's — a dead end no amount of releasing the
 * seat can clear. Light shipped exactly that once.
 *
 * Not a MAC address: those change with USB-to-Ethernet dongles, and a festival
 * box meets a different one at every venue.
 *
 * Case is left as the platform gives it. The service trims before hashing but
 * does not fold case, and macOS and Windows report upper case at source — so
 * the one rule is that the same string is used everywhere, which reading it
 * from one function guarantees.
 */
export function readFingerprint(platform: NodeJS.Platform = process.platform): string | null {
  try {
    const raw = platformId(platform)
    const trimmed = raw?.trim() ?? ''
    return trimmed ? trimmed : null
  } catch {
    // An unreadable id is "this box cannot be licensed", which the panel says
    // plainly. It is never a reason for the box not to start.
    return null
  }
}

/** Bounded, because this runs once at startup and a hung child must not hold it. */
const run = (command: string, args: string[]): string =>
  execFileSync(command, args, {
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  })

function platformId(platform: NodeJS.Platform): string | null {
  if (platform === 'darwin') {
    const out = run('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'])
    const line = out.split('\n').find((l) => l.includes('IOPlatformUUID'))
    return line?.split('"')[3] ?? null
  }
  if (platform === 'win32') {
    return parseMachineGuid(
      run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'])
    )
  }
  // Linux and everything else: systemd's id, with the D-Bus copy as the
  // fallback on the minimal images that only have that one.
  for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      const id = readFileSync(path, 'utf8').trim()
      if (id) return id
    } catch {
      // try the next
    }
  }
  return null
}

/** `MachineGuid    REG_SZ    0a1b…` → the GUID. Exported for its test. */
export function parseMachineGuid(regOutput: string): string | null {
  const match = /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(regOutput)
  return match ? match[1] : null
}
