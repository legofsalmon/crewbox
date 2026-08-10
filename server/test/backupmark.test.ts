import { describe, expect, it } from 'vitest'
import { parseBackupMark } from '../src/backupmark.ts'

/**
 * The marker deploy/backup.sh leaves behind. Written by shell, read by the
 * server, so the two can drift — and the failure mode of a bad parse is the
 * panel claiming there has never been a backup when there has. Everything
 * unparseable therefore falls back to "unknown", never to a wrong time.
 */

describe('the backup marker', () => {
  it('reads what backup.sh writes', () => {
    // Exactly the shape of the printf in deploy/backup.sh.
    expect(
      parseBackupMark('{"at":1786300000000,"dest":"/media/usb/crewbox-backups/20260809-2100"}')
    ).toEqual({ at: 1786300000000, dest: '/media/usb/crewbox-backups/20260809-2100' })
  })

  it('accepts a marker with no destination', () => {
    expect(parseBackupMark('{"at":1786300000000}')).toEqual({ at: 1786300000000 })
  })

  it('rejects a seconds stamp rather than reporting 1970', () => {
    // The classic shell mistake is `date +%s` without the trailing 000. Taken
    // literally that is January 1970, and the panel would shout about a
    // 56-year-old backup on a box backed up an hour ago.
    expect(parseBackupMark('{"at":1786300000}')).toBeNull()
  })

  it('rejects junk instead of guessing', () => {
    for (const text of ['', 'not json', '{}', '[]', '{"at":"yesterday"}', 'null']) {
      expect(parseBackupMark(text)).toBeNull()
    }
  })
})
