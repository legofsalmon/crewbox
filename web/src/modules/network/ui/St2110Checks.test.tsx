// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkCapture, loadSt2110 } from '../../../lib/st2110.ts'
import NetworkMain from '../NetworkMain.tsx'
import { fetchAudit } from '../model/api.ts'
import St2110Checks from './St2110Checks.tsx'

/**
 * The Network page's ST 2110 checks, as somebody uses them: paste or open an
 * SDP file and read it back line by line; choose a capture and its SDP
 * files, and read what the analyser found. The SDP linter is the real one;
 * the capture worker is stood in for, since a test has no workers, and is
 * handed real reports.
 */

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

vi.mock('../../../lib/st2110.ts', async () => {
  const { readFileSync } = await import('node:fs')
  const { createRequire } = await import('node:module')
  const checks = await import('@crewbox/st2110')
  const require = createRequire(import.meta.url)
  checks.initSync({ module: readFileSync(require.resolve('@crewbox/st2110/st2110_wasm_bg.wasm')) })
  return { loadSt2110: vi.fn(() => Promise.resolve(checks)), checkCapture: vi.fn() }
})

vi.mock('../model/api.ts', () => ({
  fetchAudit: vi.fn(),
  fetchSeries: vi.fn(),
}))

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

/** A pcap file's header and nothing after it. */
const PCAP = new Uint8Array([
  0xd4, 0xc3, 0xb2, 0xa1, 2, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0, 1, 0, 0, 0,
])

let root: Root
let host: HTMLElement

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.mocked(checkCapture).mockReset()
  vi.mocked(loadSt2110).mockClear()
})

const render = () => act(() => root.render(<St2110Checks />))

/** Let every pending read, load and check finish. */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  })

const panel = (name: string) => host.querySelector<HTMLElement>(`section[aria-label="${name}"]`)!

const button = (within: HTMLElement, label: string) => {
  const found = Array.from(within.querySelectorAll('button')).find((b) => b.textContent === label)
  if (!found) throw new Error(`no ${label} button`)
  return found
}

async function click(within: HTMLElement, label: string) {
  act(() => button(within, label).click())
  await settle()
}

async function type(within: HTMLElement, text: string) {
  const area = within.querySelector('textarea')!
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    setter.call(area, text)
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settle()
}

/** Choose files the way the picker hands them over. */
async function choose(within: HTMLElement, files: File[]) {
  const input = within.querySelector<HTMLInputElement>('input[type=file]')!
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
}

describe('checking an SDP file', () => {
  it('goes through a pasted file line by line, each finding under its line', async () => {
    render()
    const sdp = panel('Check an SDP file')
    expect(button(sdp, 'Check').disabled).toBe(true)
    await type(sdp, DANTE)
    await click(sdp, 'Check')

    expect(sdp.textContent).toContain('1 fault, 1 warning, 1 note in 1 stream.')
    const lines = sdp.querySelectorAll('ol[aria-label="The file, line by line"] > li')
    expect(lines).toHaveLength(13)
    expect(lines[6]!.textContent).toContain(
      'Stream 1, ST 2110-30, to 239.69.83.67:5004: L24 48 kHz, 2 channels'
    )
    expect(lines[12]!.textContent).toContain('a=mediaclk:direct=963214424')
    expect(lines[12]!.textContent).toContain('Fault')
    expect(lines[12]!.textContent).toContain('mediaclk-offset · ST 2110-10:2022 §7.3')
  })

  it('checks a file as soon as it is opened', async () => {
    render()
    const sdp = panel('Check an SDP file')
    await choose(sdp, [new File([AUDIO_PCM], 'cam1.sdp')])
    expect(sdp.querySelector('textarea')!.value).toBe(AUDIO_PCM)
    expect(sdp.textContent).toContain('Nothing a receiver would refuse in 1 stream.')
  })

  it('points a capture to the capture check', async () => {
    render()
    const sdp = panel('Check an SDP file')
    await choose(sdp, [new File([PCAP], 'stage.pcap')])
    expect(sdp.textContent).toContain(
      'stage.pcap is a capture: Check a capture, below, measures one.'
    )
    expect(loadSt2110).not.toHaveBeenCalled()
  })

  it('says so when the checks will not load, and loads them on the next try', async () => {
    vi.mocked(loadSt2110).mockRejectedValueOnce(new Error('Failed to fetch'))
    render()
    const sdp = panel('Check an SDP file')
    await type(sdp, AUDIO_PCM)
    await click(sdp, 'Check')
    expect(sdp.textContent).toContain('Could not load the checks (Failed to fetch).')
    await click(sdp, 'Check')
    expect(sdp.textContent).not.toContain('Could not load')
    expect(sdp.textContent).toContain('Nothing a receiver would refuse in 1 stream.')
  })
})

describe('checking a capture', () => {
  it('hands the capture and its SDP files to the analyser, and shows what it found', async () => {
    const checks = await loadSt2110()
    const report = checks.analyseCapture(PCAP, { sdp: [{ name: 'cam1.sdp', text: AUDIO_PCM }] })
    vi.mocked(checkCapture).mockResolvedValue({ ok: true, report })
    render()
    const capture = panel('Check a capture')
    const file = new File([PCAP], 'stage.pcap')
    await choose(capture, [file, new File([AUDIO_PCM], 'cam1.sdp'), new File(['hi'], 'notes.txt')])

    expect(capture.textContent).toContain('stage.pcap')
    expect(capture.textContent).toContain('With cam1.sdp')
    expect(capture.textContent).toContain(
      'notes.txt is not an SDP file or a pcap or pcapng capture.'
    )

    await click(capture, 'Check')
    expect(checkCapture).toHaveBeenCalledWith(
      file,
      [{ name: 'cam1.sdp', text: AUDIO_PCM }],
      expect.any(AbortSignal)
    )
    expect(capture.textContent).toContain('No RTP flows in it.')
    expect(capture.textContent).toContain(
      'Not in the capture: cam1.sdp stream 0, to 239.10.10.2:5006.'
    )
  })

  it('says what failed when the analyser could not finish', async () => {
    vi.mocked(checkCapture).mockResolvedValue({
      ok: false,
      stage: 'analyse',
      message: 'not a pcap or pcapng file',
    })
    render()
    const capture = panel('Check a capture')
    await choose(capture, [new File([PCAP], 'stage.pcap')])
    await click(capture, 'Check')
    expect(capture.textContent).toContain(
      'The analyser stopped on stage.pcap: not a pcap or pcapng file.'
    )
  })

  it('stops the analyser when asked, and when the page is left', async () => {
    const signals: AbortSignal[] = []
    vi.mocked(checkCapture).mockImplementation(
      (_file, _sdp, signal) =>
        new Promise((_resolve, reject) => {
          signals.push(signal!)
          signal!.addEventListener('abort', () => reject(signal!.reason))
        })
    )
    render()
    const capture = panel('Check a capture')
    await choose(capture, [new File([PCAP], 'stage.pcap')])
    await click(capture, 'Check')
    expect(button(capture, 'Checking…').disabled).toBe(true)

    await click(capture, 'Stop')
    expect(signals[0]!.aborted).toBe(true)
    expect(button(capture, 'Check').disabled).toBe(false)

    await click(capture, 'Check')
    act(() => root.unmount())
    expect(signals[1]!.aborted).toBe(true)
    root = createRoot(host) // for afterEach
  })
})

describe('the Network page', () => {
  it('offers the checks when the box does not answer', async () => {
    vi.mocked(fetchAudit).mockRejectedValue(new Error('offline'))
    act(() => root.render(<NetworkMain subpath="" />))
    await settle()
    expect(host.textContent).toContain('Waiting for the box: offline')
    expect(panel('Check an SDP file')).not.toBeNull()
    expect(panel('Check a capture')).not.toBeNull()
  })
})
