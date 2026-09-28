import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as st2110 from '@crewbox/st2110'
import { beforeAll, describe, expect, it } from 'vitest'
import { runCapture } from './st2110Capture.ts'

/**
 * The capture worker's whole job, without the worker: however it ends, the
 * page gets one reply, and the reply says which step failed, because that
 * is what decides the words the page shows.
 */

beforeAll(() => {
  const require = createRequire(import.meta.url)
  st2110.initSync({
    module: readFileSync(require.resolve('@crewbox/st2110/st2110_wasm_bg.wasm')),
  })
})

const load = () => Promise.resolve(st2110)

/** A pcap file's header and nothing after it: a capture of nothing at all. */
const EMPTY = new Uint8Array([
  0xd4, 0xc3, 0xb2, 0xa1, 2, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0, 1, 0, 0, 0,
])

const SDP = `v=0
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

describe('the capture worker', () => {
  it('reads the file and hands back the report, SDP files and all', async () => {
    const reply = await runCapture(load, {
      file: new Blob([EMPTY]),
      sdp: [{ name: 'cam1.sdp', text: SDP }],
    })
    expect(reply).toMatchObject({
      ok: true,
      report: {
        capture: { format: 'pcap', frames: 0 },
        missing: ['cam1.sdp stream 0, to 239.10.10.2:5006'],
      },
    })
  })

  it('says which step failed, and never throws', async () => {
    const request = { file: new Blob([EMPTY]), sdp: [] }
    expect(await runCapture(() => Promise.reject(new Error('Failed to fetch')), request)).toEqual({
      ok: false,
      stage: 'load',
      message: 'Failed to fetch',
    })

    // The file was moved or changed between choosing it and checking it.
    const gone = {
      arrayBuffer: () => Promise.reject(new DOMException('the file changed', 'NotReadableError')),
    } as unknown as Blob
    expect(await runCapture(load, { file: gone, sdp: [] })).toEqual({
      ok: false,
      stage: 'read',
      message: 'the file changed',
    })

    const prose = await runCapture(load, { file: new Blob(['not a capture at all']), sdp: [] })
    expect(prose).toMatchObject({ ok: false, stage: 'analyse' })
    expect(prose.ok || prose.message).toMatch(/not a pcap or pcapng file/)
  })
})
