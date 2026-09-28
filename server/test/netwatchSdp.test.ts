import { beforeAll, describe, expect, it } from 'vitest'
import { MAX_PROBLEMS, bitrate, checkSdp } from '../src/netwatch/sdp.ts'
import { loadSt2110, type St2110 } from '../src/st2110.ts'

/**
 * What the directory makes of an announced SDP file, with the real checks.
 * The rules themselves are legofsalmon/st2110's to test; what is tested here
 * is the line crewbox draws — which files are ST 2110's to judge, which
 * findings reach a panel, and how many.
 */

let checks: St2110

beforeAll(async () => {
  checks = (await loadSt2110())!
})

const VIDEO = [
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

const AES67 = [
  'v=0',
  'o=- 1423986 1423994 IN IP4 10.10.0.7',
  's=Monitor Mix L/R',
  'c=IN IP4 239.69.128.7/32',
  't=0 0',
  'm=audio 5004 RTP/AVP 98',
  'a=rtpmap:98 L24/48000/2',
  'a=ptime:1',
  'a=ts-refclk:ptp=IEEE1588-2008:00-1d-c1-ff-fe-11-22-33:0',
  'a=mediaclk:direct=0',
  '',
].join('\r\n')

describe('checking an announced SDP file', () => {
  it('reads a correct video file down to its facts, with nothing to report', () => {
    const result = checkSdp(VIDEO, checks)
    expect(result.st2110).toBe(true)
    expect(result.streams).toEqual([
      {
        essence: 'video',
        summary: expect.stringContaining('1920x1080'),
        destination: '239.1.1.1',
        bitrate: 2_073_600_000,
      },
    ])
    // The linter's notes (no TSMODE, here) are not problems.
    expect(result.problems).toEqual([])
  })

  it('reports what a receiver would refuse, errors first and with their lines', () => {
    const broken = VIDEO.replace(/a=mediaclk.*\r\n/, '').replace(/a=ts-refclk.*\r\n/, '')
    const result = checkSdp(broken.replace(/a=source-filter.*\r\n/, ''), checks)
    expect(result.problems.map((p) => [p.severity, p.rule])).toEqual([
      ['error', 'ts-refclk-missing'],
      ['error', 'mediaclk-missing'],
      ['warning', 'source-filter-missing'],
    ])
    expect(result.problems[0]!.line).toBe(5)
    expect(result.problems[0]!.message).toMatch(/which clock/)
  })

  it('keeps a file with many faults to the first few', () => {
    // Twelve video streams in one file, none with a source filter.
    const lines = VIDEO.split('\r\n')
    const media = lines.slice(4).filter((l) => l && !l.startsWith('a=source-filter'))
    const text = [...lines.slice(0, 4), ...Array.from({ length: 12 }, () => media).flat(), '']
    expect(checkSdp(text.join('\r\n'), checks).problems).toHaveLength(MAX_PROBLEMS)
  })

  it('leaves AES67 audio to AES67, and takes audio that says it is ST 2110-30', () => {
    expect(checkSdp(AES67, checks).st2110).toBe(false)
    const st2110Audio = AES67.replace(
      'a=ptime:1',
      'a=fmtp:98 channel-order=SMPTE2110.(ST)\r\na=ptime:1'
    )
    expect(checkSdp(st2110Audio, checks).st2110).toBe(true)
  })

  it('writes bitrates as a video engineer does', () => {
    expect(bitrate(2_073_600_000)).toBe('2.07 Gb/s')
    expect(bitrate(36_864_000)).toBe('36.9 Mb/s')
    expect(bitrate(2_304_000)).toBe('2.3 Mb/s')
    expect(bitrate(96_000)).toBe('96 kb/s')
  })
})
