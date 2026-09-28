import { expect } from '@playwright/test'
import { newDevice, test } from './helpers'

/**
 * The network audit pane. The e2e box listens to sACN on loopback and does
 * not run the media watchers, so the honest expectations are: crew card
 * present with live counts, lighting card graded from the loopback
 * listener, media card saying "Not watched" — degradation is part of the
 * product, so it is part of the test.
 */

test('the audit pane grades the three networks for any crew member', async ({ browser }) => {
  const page = await newDevice(browser)
  await page.getByRole('button', { name: 'Open network audit' }).click()

  await expect(page.getByRole('heading', { name: 'Network', exact: true })).toBeVisible()

  // Three cards, always — a network the box can't see says so rather than
  // disappearing.
  const crew = page.getByRole('region', { name: 'Crew network' })
  await expect(crew).toBeVisible()
  await expect(crew.getByText(/connection/)).toBeVisible()

  const lighting = page.getByRole('region', { name: 'Lighting network' })
  await expect(lighting).toBeVisible()

  const media = page.getByRole('region', { name: 'Audio & media network' })
  await expect(media).toBeVisible()
  await expect(media.getByText('Not watched')).toBeVisible()
  // The unwatched card carries the fix, not a fake verdict.
  await expect(media.getByText(/Watch the media network/)).toBeVisible()

  // The event strip renders (quiet is a valid, stated answer).
  await expect(page.getByRole('region', { name: 'Events, last 24 hours' })).toBeVisible()

  // The report downloads as one self-contained HTML file.
  const download = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download HTML report' }).click(),
  ]).then(([d]) => d)
  expect(download.suggestedFilename()).toMatch(/^crewbox-network-audit-\d{4}-\d{2}-\d{2}\.html$/)
})

test('a phone can get into and back out of the audit pane', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  await page.goto('/?pin=4242')
  await page.getByLabel('Your name').fill(`Audit Tech ${Date.now().toString(36)}`)
  await page.getByLabel('Your PIN').fill('1234')
  await page.getByRole('button', { name: 'Join' }).click()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()

  await page.getByRole('button', { name: 'Open channels' }).first().click()
  await page.getByRole('button', { name: 'Open network audit' }).click()
  await expect(page.getByRole('heading', { name: 'Network', exact: true })).toBeVisible()

  // The drawer button is there — the phone user is never stranded.
  await page.getByRole('button', { name: 'Open channels' }).click()
  await page.getByRole('button', { name: '#general' }).click()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()

  await context.close()
})

/**
 * The ST 2110 checks, run for real: the WebAssembly fetched and started in
 * the page for an SDP file, and again in the capture analyser's own worker.
 * Nothing about either touches the box, so this is the one place the worker,
 * the built asset URLs and the module worker format are proved together.
 */

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

const CAMERA_AUDIO = `v=0
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
 * 20 ms of CAMERA_AUDIO's stream as a pcap file, sent with payload type 98
 * where its SDP file says 97: legofsalmon/st2110's smoke-test capture, cut
 * short.
 */
function mistypedCapture(): Buffer {
  const packets = 20
  const frameLength = 14 + 20 + 8 + 12 + 48 * 3 * 8
  const bytes = Buffer.alloc(24 + packets * (16 + frameLength))
  bytes.set([0x4d, 0x3c, 0xb2, 0xa1, 2, 0, 4, 0])
  bytes.writeUInt32LE(65535, 16)
  bytes.writeUInt32LE(1, 20)
  let at = 24
  for (let i = 0; i < packets; i++) {
    const millisecond = 1790510437000n + BigInt(i)
    const arrival = (millisecond + 1n) * 1000000n + 150000n
    bytes.writeUInt32LE(Number(arrival / 1000000000n), at)
    bytes.writeUInt32LE(Number(arrival % 1000000000n), at + 4)
    bytes.writeUInt32LE(frameLength, at + 8)
    bytes.writeUInt32LE(frameLength, at + 12)
    at += 16
    bytes.set(
      [0x01, 0x00, 0x5e, 0x0a, 0x0a, 0x02, 0x02, 0, 0, 0, 0, 0x01, 0x08, 0x00, 0x45, 0xb8],
      at
    )
    bytes.writeUInt16BE(frameLength - 14, at + 16)
    bytes.set([0, 1, 0x40, 0, 64, 17, 0, 0, 192, 168, 10, 22, 239, 10, 10, 2], at + 18)
    bytes.writeUInt16BE(5006, at + 34)
    bytes.writeUInt16BE(5006, at + 36)
    bytes.writeUInt16BE(frameLength - 34, at + 38)
    bytes.set([0x80, 98], at + 42)
    bytes.writeUInt16BE(i, at + 44)
    bytes.writeUInt32BE(Number((millisecond * 48n) % 2n ** 32n), at + 46)
    bytes.writeUInt32BE(0x22220002, at + 50)
    bytes.fill(0x11, at + 54, at + frameLength)
    at += frameLength
  }
  return bytes
}

test('the ST 2110 checks run on the device, for anyone', async ({ browser }) => {
  const page = await newDevice(browser)
  await page.getByRole('button', { name: 'Open network audit' }).click()

  const sdp = page.getByRole('region', { name: 'Check an SDP file' })
  await sdp.getByLabel('SDP file').fill(DANTE)
  await sdp.getByRole('button', { name: 'Check', exact: true }).click()
  await expect(sdp.getByText('1 fault, 1 warning, 1 note in 1 stream.')).toBeVisible()
  await expect(sdp.getByText(/RTP clock offset 963214424/)).toBeVisible()

  const capture = page.getByRole('region', { name: 'Check a capture' })
  await capture.locator('input[type=file]').setInputFiles([
    { name: 'stage.pcap', mimeType: 'application/octet-stream', buffer: mistypedCapture() },
    { name: 'cam1.sdp', mimeType: 'application/sdp', buffer: Buffer.from(CAMERA_AUDIO) },
  ])
  await expect(capture.getByText('With cam1.sdp')).toBeVisible()
  await capture.getByRole('button', { name: 'Check', exact: true }).click()
  await expect(capture.getByText('1 fault in 1 RTP flow.')).toBeVisible()
  await expect(capture.getByText(/20 packets carried payload type 98/)).toBeVisible()
  await expect(
    capture.getByText(
      'Flow 1: 192.168.10.22:5006 to 239.10.10.2:5006, ST 2110-30, cam1.sdp stream 0'
    )
  ).toBeVisible()
})
