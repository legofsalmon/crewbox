import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as st2110 from '@crewbox/st2110'
import type { FlowReport, PtpDomainReport } from '@crewbox/st2110'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  annotateSdp,
  captureFacts,
  captureTooBig,
  captureVerdict,
  clockNote,
  clockWords,
  count,
  describeFlow,
  describePtpDomain,
  findingWhere,
  identify,
  sdpVerdict,
  size,
  sortFindings,
  streamWords,
} from './st2110.ts'

/**
 * The page's words for the ST 2110 checks, against the checks themselves:
 * SDP files from legofsalmon/st2110's own tests (crates/sdp/tests/fixtures),
 * and the capture its WebAssembly smoke test builds (crates/wasm/tests).
 */

beforeAll(() => {
  const require = createRequire(import.meta.url)
  st2110.initSync({
    module: readFileSync(require.resolve('@crewbox/st2110/st2110_wasm_bg.wasm')),
  })
})

const VIDEO_DUP = `v=0
o=- 1790510437 1790510437 IN IP4 192.168.10.21
s=CAM 1 video
t=0 0
a=group:DUP primary secondary
m=video 5004 RTP/AVP 96
c=IN IP4 239.10.10.1/32
a=source-filter: incl IN IP4 239.10.10.1 192.168.10.21
a=rtpmap:96 raw/90000
a=fmtp:96 sampling=YCbCr-4:2:2; width=1920; height=1080; exactframerate=50; depth=10; TCS=SDR; colorimetry=BT709; PM=2110GPM; SSN=ST2110-20:2017; TP=2110TPN; TSMODE=SAMP
a=ts-refclk:ptp=IEEE1588-2008:08-00-11-FF-FE-21-E1-B0:127
a=mediaclk:direct=0
a=mid:primary
m=video 5004 RTP/AVP 96
c=IN IP4 239.20.10.1/32
a=source-filter: incl IN IP4 239.20.10.1 192.168.20.21
a=rtpmap:96 raw/90000
a=fmtp:96 sampling=YCbCr-4:2:2; width=1920; height=1080; exactframerate=50; depth=10; TCS=SDR; colorimetry=BT709; PM=2110GPM; SSN=ST2110-20:2017; TP=2110TPN; TSMODE=SAMP
a=ts-refclk:ptp=IEEE1588-2008:08-00-11-FF-FE-21-E1-B0:127
a=mediaclk:direct=0
a=mid:secondary
`

/** A Dante stage box's file: AES67, not ST 2110, so its clock offset is a fault here. */
const DANTE = `v=0
o=- 1311738121 1311738121 IN IP4 192.168.1.100
s=Stage box 1
c=IN IP4 239.69.83.67/32
t=0 0
a=keywds:Dante
m=audio 5004 RTP/AVP 97
i=2 channels: Left, Right
a=recvonly
a=rtpmap:97 L24/48000/2
a=ptime:1
a=ts-refclk:ptp=IEEE1588-2008:00-1D-C1-FF-FE-12-34-56:0
a=mediaclk:direct=963214424
`

const AUDIO_PCM = `v=0
o=- 1790510438 1790510438 IN IP4 192.168.10.22
s=CAM 1 audio
t=0 0
m=audio 5006 RTP/AVP 97
c=IN IP4 239.10.10.2/32
a=source-filter: incl IN IP4 239.10.10.2 192.168.10.22
a=rtpmap:97 L24/48000/8
a=fmtp:97 channel-order=SMPTE2110.(51,ST); TSMODE=SAMP
a=ptime:1
a=ts-refclk:ptp=IEEE1588-2008:08-00-11-FF-FE-21-E1-B0:127
a=mediaclk:direct=0
`

/**
 * 200 ms of the audio in AUDIO_PCM from noon, PTP time, as a pcap file with
 * nanosecond timestamps: 1 ms packets arriving 150 µs after their last
 * sample. The same capture the st2110 smoke test builds.
 */
function audioCapture(payloadType: number): Uint8Array<ArrayBuffer> {
  const frameLength = 14 + 20 + 8 + 12 + 48 * 3 * 8
  const bytes = new Uint8Array(24 + 200 * (16 + frameLength))
  const view = new DataView(bytes.buffer)
  bytes.set([0x4d, 0x3c, 0xb2, 0xa1, 2, 0, 4, 0])
  view.setUint32(16, 65535, true)
  view.setUint32(20, 1, true)
  let at = 24
  for (let i = 0; i < 200; i++) {
    const millisecond = 1790510437000n + BigInt(i)
    const arrival = (millisecond + 1n) * 1000000n + 150000n
    view.setUint32(at, Number(arrival / 1000000000n), true)
    view.setUint32(at + 4, Number(arrival % 1000000000n), true)
    view.setUint32(at + 8, frameLength, true)
    view.setUint32(at + 12, frameLength, true)
    at += 16
    bytes.set(
      [0x01, 0x00, 0x5e, 0x0a, 0x0a, 0x02, 0x02, 0, 0, 0, 0, 0x01, 0x08, 0x00, 0x45, 0xb8],
      at
    )
    view.setUint16(at + 16, frameLength - 14)
    bytes.set([0, 1, 0x40, 0, 64, 17, 0, 0, 192, 168, 10, 22, 239, 10, 10, 2], at + 18)
    view.setUint16(at + 34, 5006)
    view.setUint16(at + 36, 5006)
    view.setUint16(at + 38, frameLength - 34)
    bytes.set([0x80, payloadType], at + 42)
    view.setUint16(at + 44, i)
    view.setUint32(at + 46, Number((millisecond * 48n) % 2n ** 32n))
    view.setUint32(at + 50, 0x22220002)
    bytes.fill(0x11, at + 54, at + frameLength)
    at += frameLength
  }
  return bytes
}

describe('an SDP file, line by line', () => {
  it('puts each finding under its line, and each stream under its m= line', () => {
    const report = st2110.lint(DANTE)
    const { general, lines } = annotateSdp(DANTE, report)
    expect(general).toEqual([])
    expect(lines).toHaveLength(13)
    const media = lines[6]!
    expect(media.text).toBe('m=audio 5004 RTP/AVP 97')
    expect(media.stream?.index).toBe(0)
    expect(media.diagnostics.map((d) => d.rule)).toEqual(['source-filter-missing', 'tsmode-absent'])
    expect(lines[12]!.diagnostics.map((d) => [d.severity, d.rule])).toEqual([
      ['error', 'mediaclk-offset'],
    ])
    expect(sdpVerdict(report)).toEqual({
      state: 'off',
      words: '1 fault, 1 warning, 1 note in 1 stream.',
    })
  })

  it('numbers the lines as the linter does, whatever ends them', () => {
    // A byte-order mark, Windows line endings and blank lines at the end,
    // with a fault in the second stream to find.
    const text =
      `\uFEFF${VIDEO_DUP.replace('direct=0\na=mid:secondary', 'direct=5\na=mid:secondary')}\n\n`
        .split('\n')
        .join('\r\n')
    const report = st2110.lint(text)
    const { lines } = annotateSdp(text, report)
    expect(lines).toHaveLength(21)
    expect(lines.every((line) => !line.text.includes('\r'))).toBe(true)
    expect(lines[0]!.text).toBe('v=0')
    expect([lines[5]!.stream?.index, lines[13]!.stream?.index]).toEqual([0, 1])
    expect(lines[19]!.text).toBe('a=mediaclk:direct=5')
    expect(lines[19]!.diagnostics.map((d) => d.rule)).toEqual(['mediaclk-offset'])
  })

  it('keeps what is said of the file as a whole apart from its lines', () => {
    const empty = st2110.lint('')
    expect(annotateSdp('', empty)).toEqual({ general: empty.diagnostics, lines: [] })
    expect(sdpVerdict(empty)).toEqual({ state: 'off', words: '1 fault, and no streams in it.' })

    const prose = st2110.lint('hello')
    const annotated = annotateSdp('hello', prose)
    expect(annotated.general.map((d) => d.rule)).toEqual(['sdp-required-line'])
    expect(annotated.lines[0]!.diagnostics.map((d) => d.rule)).toEqual(['sdp-syntax'])
  })

  it('says when there is nothing a receiver would refuse', () => {
    expect(sdpVerdict(st2110.lint(VIDEO_DUP))).toEqual({
      state: 'ok',
      words: 'Nothing a receiver would refuse in 2 streams.',
    })
    // Dante's own file with the offset ST 2110 forbids taken out: what is
    // left is worth a look, but no receiver would refuse it.
    const tidied = DANTE.replace('direct=963214424', 'direct=0')
    expect(sdpVerdict(st2110.lint(tidied))).toEqual({
      state: 'limited',
      words: 'Nothing a receiver would refuse in 1 stream; 1 warning, 1 note.',
    })
  })

  it('says what each stream is, and where it goes', () => {
    const [stream] = st2110.lint(VIDEO_DUP).streams
    expect(streamWords(stream!)).toBe(
      'Stream 1, ST 2110-20, to 239.10.10.1:5004: 1920x1080 progressive, 50 fps, ' +
        'YCbCr-4:2:2 10-bit, BT709 SDR, 2110GPM, 2110TPN, 2.07 Gb/s'
    )
    expect(streamWords({ ...stream!, destination: 'ff3e::1:2' })).toContain('to [ff3e::1:2]:5004:')
  })
})

describe('telling a capture from an SDP file', () => {
  it('goes by what is in the file, not its name', async () => {
    const pcap = await identify(new File([audioCapture(97)], 'camera.bin'))
    expect(pcap.kind).toBe('capture')
    const pcapng = new Uint8Array([0x0a, 0x0d, 0x0d, 0x0a, 28, 0, 0, 0])
    expect((await identify(new File([pcapng], 'trace'))).kind).toBe('capture')
    expect(await identify(new File([AUDIO_PCM], 'cam1.txt'))).toEqual({
      kind: 'sdp',
      sdp: { name: 'cam1.txt', text: AUDIO_PCM },
    })
  })

  it('says why it will not take a file', async () => {
    expect(await identify(new File(['hello'], 'notes.sdp'))).toEqual({
      kind: 'refused',
      why: 'notes.sdp is not an SDP file or a pcap or pcapng capture.',
    })
    expect(await identify(new File([new Uint8Array(70_000)], 'photo.jpg'))).toEqual({
      kind: 'refused',
      why: 'photo.jpg is 70 kB: too big for an SDP file, and not a pcap or pcapng capture.',
    })
  })

  it('refuses a capture too big for a browser, and says what to do instead', () => {
    const big = new File([], 'overnight.pcapng')
    Object.defineProperty(big, 'size', { value: 2 * 1024 ** 3 })
    expect(captureTooBig(big)).toBe(
      'overnight.pcapng is 2.1 GB, more than a browser can be asked to hold. ' +
        'Cut it down with editcap, or check it with the st2110 command on a computer.'
    )
    expect(captureTooBig(new File([audioCapture(97)], 'ok.pcap'))).toBeNull()
  })
})

describe('a capture, in the words st2110 pcap uses', () => {
  const sdp = [
    { name: 'audio-pcm.sdp', text: AUDIO_PCM },
    { name: 'video-dup.sdp', text: VIDEO_DUP },
  ]

  it('describes a clean capture: the file, its clock and each flow', () => {
    const report = st2110.analyseCapture(audioCapture(97), { sdp: sdp.slice(0, 1) })
    expect(captureVerdict(report)).toEqual({ state: 'ok', words: 'No faults in 1 RTP flow.' })
    expect(captureFacts(report)).toBe(
      'pcap (nanosecond), 200 frames over 0.199 s (241 kB): 200 RTP packets in 1 flow, 0 PTP messages.'
    )
    expect(clockWords(report.timescale)).toBe(
      "The capture's clock is PTP time: with no PTP Sync messages to go by, the timestamps of " +
        '1 of 1 RTP flow sit within half a second of PTP time.'
    )
    expect(clockNote(report.timescale)).toBeNull()
    expect(describeFlow(report.flows[0]!)).toEqual({
      heading: 'Flow 1: 192.168.10.22:5006 to 239.10.10.2:5006, ST 2110-30, audio-pcm.sdp stream 0',
      details: [
        '200 packets (payload type 97, SSRC 22220002) at 9.5 Mb/s',
        'Audio: L24, 48 kHz, 8 channels, 48 samples a packet (1000.0 µs)',
        'Latency 1150.0 µs (1150.0 to 1150.0), packet interval 1000.0 µs (1000.0 to 1000.0), ' +
          'TS-DF at most 0.0 µs',
      ],
    })
  })

  it('says where and when each fault happened, and which streams never turned up', () => {
    const report = st2110.analyseCapture(audioCapture(98), { sdp })
    expect(captureVerdict(report)).toEqual({ state: 'off', words: '1 fault in 1 RTP flow.' })
    const [finding] = sortFindings(report.findings)
    expect(finding!.rule).toBe('payload-type-mismatch')
    expect(findingWhere(finding!, report.flows)).toBe(
      'Flow 1 (to 239.10.10.2:5006), first at 0.000 s, 200 times'
    )
    expect(report.missing).toEqual([
      'video-dup.sdp stream 0, to 239.10.10.1:5004',
      'video-dup.sdp stream 1, to 239.20.10.1:5004',
    ])
  })

  it('counts a file that stops partway as a fault, as the command line does', () => {
    const report = st2110.analyseCapture(audioCapture(97).slice(0, -10))
    expect(report.capture.error).toBe('the file ends partway through a packet')
    expect(captureVerdict(report)).toEqual({ state: 'off', words: '1 fault in 1 RTP flow.' })
    // With no SDP file, the flow was recognised from its packets.
    expect(describeFlow(report.flows[0]!).heading).toMatch(/, ST 2110-30 by its packets$/)
  })

  it('says so when there is nothing in it to check', () => {
    const empty = audioCapture(97).slice(0, 24)
    expect(captureVerdict(st2110.analyseCapture(empty))).toEqual({
      state: 'limited',
      words: 'No RTP flows in it.',
    })
  })

  it('puts faults first, keeping the order the analyser found them in', () => {
    const finding = (rule: string, severity: 'error' | 'warning' | 'info') => ({
      rule,
      severity,
      message: '',
      reference: '',
      flow: null,
      domain: null,
      at: null,
      count: 1,
    })
    const sorted = sortFindings([
      finding('a', 'info'),
      finding('b', 'warning'),
      finding('c', 'error'),
      finding('d', 'warning'),
      finding('e', 'error'),
    ])
    expect(sorted.map((f) => f.rule)).toEqual(['c', 'e', 'b', 'd', 'a'])
    expect(findingWhere({ ...finding('p', 'error'), domain: 127, at: 2.5 }, [])).toBe(
      'PTP domain 127, first at 2.500 s'
    )
    expect(findingWhere({ ...finding('q', 'error'), at: 0.25, count: 3 }, [])).toBe(
      'First at 0.250 s, 3 times'
    )
  })

  it("words a video flow's ST 2110-21 models as the command line does", () => {
    const stats = (min: number, max: number, mean: number) => ({ count: 10, min, max, mean })
    const flow: FlowReport = {
      index: 2,
      source: '192.168.10.21:5004',
      destination: '239.10.10.1:5004',
      essence: 'video',
      sdp: 'video-dup.sdp stream 0',
      guessed: false,
      payload_type: 96,
      ssrc: '0a0b0c0d',
      packets: 43_200,
      bytes: 51_840_000,
      first: 0,
      last: 0.2,
      mbps: 2073.6,
      lost: 3,
      out_of_order: 0,
      duplicates: 1,
      audio: null,
      video: {
        frame_rate: '30000/1001',
        height: 1080,
        interlaced: false,
        segmented: false,
        units: 6,
        packets_per_frame: stats(4320, 4320, 4320),
        npackets: 4320,
        fpt: stats(12, 14.5, 13.2),
        rtp_offset: null,
        latency: null,
        gap: null,
        cinst: {
          peak: 5,
          sender_type: '2110TPN',
          cmax: 4,
          signalled_cmax: null,
          cmax_narrow: 4,
          cmax_narrow_linear: 4,
          cmax_wide: 16,
          fits: ['2110TPW'],
          drain_us: 3.7,
        },
        vrx: {
          schedule: 'gapped',
          troffset_us: 43.2,
          troffset_signalled: false,
          vrxfull: 8,
          peak: 9,
          underflows: 0,
          overflows: 2,
          margin_us: stats(-1.25, 30, 12),
          method: '',
        },
        models_skipped: null,
        vrx_skipped: null,
        windows: [],
      },
    }
    expect(describeFlow(flow).details).toEqual([
      '43,200 packets (payload type 96, SSRC 0a0b0c0d) at 2073.6 Mb/s, 3 lost, 1 duplicated',
      'Video: 1080 lines, progressive, 29.97 frames a second, 6 frames, 4320 packets a frame',
      'First packet time 13.2 µs (12.0 to 14.5)',
      'CINST peaked at 5, CMAX 4 for 2110TPN; fits 2110TPW',
      'Virtual receiver buffer peaked at 9 of VRXFULL 8, gapped reads from TROFFSET 43.2 µs; ' +
        'packets arrived as much as 1.3 µs after their reads, 2 overflows',
    ])
  })

  it("words a PTP domain's grandmasters and messages", () => {
    const domain: PtpDomainReport = {
      domain: 127,
      grandmasters: ['08-00-11-FF-FE-21-E1-B0'],
      ports: [
        {
          port: '08-00-11-FF-FE-21-E1-B0/1',
          address: '192.168.10.1',
          messages: [
            { kind: 'Sync', count: 1600, log_interval: -3, interval_ms: stats(125) },
            { kind: 'Announce', count: 50, log_interval: 1, interval_ms: null },
          ],
        },
      ],
      sync_offset_us: { count: 1600, min: 0.5, max: 2.25, mean: 1.2 },
    }
    expect(describePtpDomain(domain)).toEqual({
      heading: 'PTP domain 127: grandmaster 08-00-11-FF-FE-21-E1-B0',
      details: [
        '08-00-11-FF-FE-21-E1-B0/1 at 192.168.10.1: 1,600 Sync every 125.0 ms, 50 Announce',
        'Sync arrival less departure 1.2 µs (0.5 to 2.3)',
      ],
    })
    expect(describePtpDomain({ ...domain, grandmasters: [], ports: [] }).heading).toBe(
      'PTP domain 127: no Announce messages'
    )
    function stats(mean: number) {
      return { count: 10, min: mean, max: mean, mean }
    }
  })
})

describe('numbers', () => {
  it('counts and sizes the way the rest of the page does', () => {
    expect([count(1, 'flow'), count(12_000, 'packet')]).toEqual(['1 flow', '12,000 packets'])
    expect([size(512), size(241_200), size(999_999), size(1.2e9)]).toEqual([
      '512 B',
      '241 kB',
      '1.0 MB',
      '1.2 GB',
    ])
  })
})
