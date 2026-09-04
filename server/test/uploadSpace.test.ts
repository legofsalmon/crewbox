import { describe, expect, it } from 'vitest'
import { roomForUpload } from '../src/app.ts'

/**
 * The box's own code says what a full disk costs: the audit rollup throws on
 * SQLITE_FULL inside an interval, so a box that filled its disk on day four
 * did not lose its graphs, it lost its comms. Nothing stopped anybody
 * filling it — a PIN holder with a phone and a hundred-megabyte limit needs
 * twenty uploads to take a small box down, and none of it looks like an
 * attack. It looks like somebody sharing videos.
 */

const GB = 1024 * 1024 * 1024
const MB = 1024 * 1024

describe('whether there is room for another attachment', () => {
  it('yes, on a box with space', () => {
    expect(roomForUpload(20 * GB)).toBe(true)
  })

  it('no, once the reserve is what is left', () => {
    // Two gigabytes is the same figure the readiness panel calls low, so a
    // crew that sees the disk row go amber has the reason.
    expect(roomForUpload(2 * GB)).toBe(false)
    expect(roomForUpload(500 * MB)).toBe(false)
    expect(roomForUpload(0)).toBe(false)
  })

  it('subtracts the worst case, because the decision comes before the bytes', () => {
    // Deciding after the write means the file is already on the disk this
    // is protecting. 2 GB reserve + 100 MB upload is the line.
    expect(roomForUpload(2 * GB + 100 * MB)).toBe(true)
    expect(roomForUpload(2 * GB + 100 * MB - 1)).toBe(false)
  })

  it('allows it on a filesystem that will not say', () => {
    // `statfs` fails on some mounts and in some containers. Not knowing is
    // not the same as knowing there is no room, and a crew sharing a
    // photograph must not be stopped by a syscall that did not answer.
    expect(roomForUpload(null)).toBe(true)
  })
})
