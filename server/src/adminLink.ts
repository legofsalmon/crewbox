import { timingSafeEqual } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { newToken } from './auth.ts'
import { readBoxStatus, type BoxStatus } from './box.ts'

/**
 * The admin link: a way into the admin panel for whoever is at the box
 * itself, without the password.
 *
 * The password is minted on first start and printed to the box's console,
 * and the first-run setup page shows it once. A Mac box started from the
 * .app has no console at all, and a password missed on the setup page was
 * gone: the only way back in was ADMIN_PASSWORD in an environment that a
 * double-clicked app does not really have.
 *
 * **Why a key in a file, and not "the browser is on the same machine".** The
 * box can tell that a connection came from itself — it arrives from one of
 * the box's own addresses — but that is not the same as a person at the box.
 * The runbook's remote-support tunnel runs on the box and hands every
 * internet visitor to localhost, and so does any reverse proxy or port
 * forward on it. And a browser on the box will send whatever any website it
 * has open tells it to, to localhost, where the box answers every origin
 * (the apps need that; see the CORS registration in app.ts). Trusting the
 * address would have made all of those an admin.
 *
 * A key in the data directory asks for something none of them has: the
 * login on the machine the box runs as. That is already what the other ways
 * back in ask for — ADMIN_PASSWORD, or the console — and what the menu-bar
 * item and tray icon already have, since they read box-status.json from the
 * same directory.
 *
 * The key works once. It is replaced the moment it is used and whenever the
 * box starts, so a link left in a browser's history or a terminal's
 * scrollback is dead by the time anybody finds it.
 */

/**
 * Where the link is kept, beside box-status.json.
 *
 * Read by the menu-bar item (native/macos), the tray icon (native/windows)
 * and `crewbox --admin`, any of which may be a different version from the
 * box, so the name and the two fields stay as they are.
 */
export const ADMIN_LINK_FILE = 'admin-link.json'

/** What the file holds: the link, and which process's key is in it. */
export interface AdminLinkFile {
  pid: number
  url: string
}

export function adminLinkPath(dataDir: string): string {
  return join(dataDir, ADMIN_LINK_FILE)
}

/**
 * The link for one key, at the address the box sends its own browser to.
 *
 * The key goes in the fragment, which a browser never sends: it is not in
 * the request for the page, so it is not in the box's log or anybody's
 * proxy's, and the page takes it out of the address bar as it loads
 * (web/src/lib/adminLink.ts). `?admin` is what opens the panel, as it
 * already was for the helpers' "Update available" item.
 */
export function adminLinkUrl(origin: string, key: string): string {
  return `${origin}/?admin#admin-key=${key}`
}

/**
 * Publish the current link for the helpers to read.
 *
 * Readable by this user only, since the key in it is as good as the
 * password once. `mode` applies only to a file that `open` creates, so it is
 * written to a new file and moved over the old one rather than written in
 * place, which would keep whatever mode the old one had.
 *
 * Never throws. Without the file the menu item opens the password prompt,
 * which is where things stood before, and a box that will not start or an
 * unlock that fails over a file would be worse.
 */
export function writeAdminLink(dataDir: string, link: AdminLinkFile): void {
  const path = adminLinkPath(dataDir)
  const staging = `${path}.partial`
  const body = JSON.stringify(link, null, 2)
  try {
    rmSync(staging, { force: true })
    writeFileSync(staging, body, { mode: 0o600 })
    renameSync(staging, path)
  } catch {
    // Windows refuses the rename while a tray icon has the file open to
    // read it. Writing in place is the fallback, and there the mode means
    // nothing anyway: a Windows profile directory is its user's alone.
    try {
      writeFileSync(path, body, { mode: 0o600 })
    } catch {
      /* the password prompt is still there */
    }
    try {
      rmSync(staging, { force: true })
    } catch {
      /* tidying up */
    }
  }
}

/**
 * Remove the link on a clean exit, if it is this process's.
 *
 * Only if: mid-update two boxes share the data directory, and the one
 * stopping may be the build that failed, whose link has already been
 * replaced by the box taking the port back. A box killed outright leaves a
 * dead link behind, which readers ignore by its pid.
 */
export function clearAdminLink(dataDir: string, pid = process.pid): void {
  try {
    const path = adminLinkPath(dataDir)
    let owner: unknown
    try {
      owner = (JSON.parse(readFileSync(path, 'utf8')) as Partial<AdminLinkFile>).pid
    } catch {
      owner = pid // missing or unreadable: nothing worth keeping
    }
    if (owner === pid) rmSync(path, { force: true })
  } catch {
    /* tidying up must never fail a shutdown */
  }
}

/**
 * The published link, or null when there is none or its box is gone.
 *
 * The pid is checked for the same reason box-status.json's is: a power cut
 * leaves the file behind, and a key only means anything to the process that
 * minted it.
 */
export function readAdminLink(dataDir: string): AdminLinkFile | null {
  try {
    const link = JSON.parse(readFileSync(adminLinkPath(dataDir), 'utf8')) as Partial<AdminLinkFile>
    if (typeof link?.pid !== 'number' || typeof link.url !== 'string') return null
    try {
      process.kill(link.pid, 0)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EPERM') return null
    }
    return { pid: link.pid, url: link.url }
  } catch {
    return null
  }
}

/**
 * The key itself: one at a time, held in memory, spent on use.
 *
 * `publish` is told every key as it is minted — at start, and after every
 * use — and is what puts it where the helpers look.
 */
export class AdminLinkKey {
  private key = newToken()

  constructor(private readonly publish: (key: string) => void = () => {}) {
    this.publish(this.key)
  }

  /**
   * Spend the key, if this is it.
   *
   * A right one is replaced at once, so each link opens the panel exactly
   * once. A wrong one changes nothing: replacing the key on a miss would let
   * anybody who can reach the box break the link in the box's own menu.
   */
  redeem(candidate: string): boolean {
    const given = Buffer.from(candidate)
    const current = Buffer.from(this.key)
    if (given.length !== current.length || !timingSafeEqual(given, current)) return false
    this.key = newToken()
    this.publish(this.key)
    return true
  }

  /**
   * Publish the current key again, unchanged.
   *
   * For a box that got its port back after an update failed: the new build
   * wrote its own key over this one's, and then went away.
   */
  republish(): void {
    this.publish(this.key)
  }
}

/**
 * The same link at another address of the box, or null if it is the same.
 *
 * The published link points where the box sends its own browser, which is
 * localhost on a box without a certificate. Somebody who ran `--admin` over
 * SSH is holding a laptop, not the box, and needs the address crew use.
 */
export function adminLinkAt(link: string, base: string): string | null {
  try {
    const from = new URL(link)
    const to = new URL(base)
    if (from.origin === to.origin) return null
    return `${to.origin}${from.pathname}${from.search}${from.hash}`
  } catch {
    return null
  }
}

/**
 * `crewbox --admin`: print a link that opens the admin panel, once.
 *
 * For a box with no menu bar or tray to click: Linux, or a machine reached
 * over SSH. Returns a process exit code.
 */
export function printAdminLink(
  dataDir: string,
  status: BoxStatus | null = readBoxStatus(dataDir)
): number {
  const link = readAdminLink(dataDir)
  if (!link) {
    console.log('No box is running here, or it is too old to make admin links.')
    return 1
  }
  const elsewhere = status ? adminLinkAt(link.url, status.joinUrl) : null
  console.log('Open this to unlock the admin panel. It works once; run this again for another.')
  console.log('')
  console.log(`  On this machine:      ${link.url}`)
  if (elsewhere) console.log(`  From another device:  ${elsewhere}`)
  console.log('')
  console.log('Once in, you can set a new admin password under Admin → This box.')
  return 0
}
