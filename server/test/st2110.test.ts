import { describe, expect, it } from 'vitest'
import { loadSt2110, st2110, st2110Error } from '../src/st2110.ts'

/**
 * The ST 2110 checks as the box loads them: from the workspace here, from
 * the binary in a box (scripts/build-box.mjs, which the box job's smoke test
 * exercises). What is tested is that the module arrives and answers — what
 * the checks themselves say is legofsalmon/st2110's to test, and it does.
 */

const SDP = [
  'v=0',
  'o=- 1 1 IN IP4 10.0.0.1',
  's=CAM 1',
  't=0 0',
  'm=video 5004 RTP/AVP 96',
  'c=IN IP4 239.1.1.1/32',
  'a=source-filter: incl IN IP4 239.1.1.1 10.0.0.1',
  'a=rtpmap:96 raw/90000',
  'a=fmtp:96 sampling=YCbCr-4:2:2; width=1920; height=1080; exactframerate=50; depth=10; TCS=SDR; colorimetry=BT709; PM=2110GPM; SSN=ST2110-20:2017; TP=2110TPN',
  'a=mediaclk:direct=0',
  'a=ts-refclk:ptp=IEEE1588-2008:00-11-22-ff-fe-33-44-55:127',
  '',
].join('\r\n')

describe('the ST 2110 checks on the box', () => {
  it('load once, and lint an SDP file', async () => {
    const first = loadSt2110()
    expect(loadSt2110()).toBe(first)
    const checks = await first
    expect(st2110Error()).toBeNull()
    expect(checks).not.toBeNull()
    expect(st2110()).toBe(checks)

    const report = checks!.lint(SDP)
    expect(report.streams).toHaveLength(1)
    expect(report.streams[0]).toMatchObject({
      essence: 'video',
      destination: '239.1.1.1',
      payload_bitrate: 2_073_600_000,
    })
  })

  it('decode a PTP message, and refuse what is not one', async () => {
    const checks = (await loadSt2110())!
    expect(() => checks.decodePtp(new Uint8Array([1, 2, 3]))).toThrow(/not a PTP message/)
  })
})
