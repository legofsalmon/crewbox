#!/usr/bin/env node
/**
 * The alerts contract's cases and frames, written to
 * native/android/app/src/test/resources/alerts-fixtures.json.
 *
 *   node scripts/alerts-fixtures.mjs
 *
 * The box decides what alerts (shared/src/alerts.ts) and the phones post what
 * it sends, so two things have to agree about the same JSON: the box that
 * writes a frame and each phone's code that reads it. Each frame is written
 * once, here, and read by server/test/alerts.test.ts (which also builds the
 * alerts in it from the shared rules and checks they come out the same) and
 * by the Android app's AlertsFixturesTest. The iPhone's provider reads the
 * same file once it has a test target.
 *
 * The rule cases carry their answers written by hand, not worked out by the
 * rules they test.
 *
 * The signed first frame is made with a P-256 key from a fixed seed, which no
 * box or phone trusts. ECDSA signatures are randomised, so a signature that
 * still verifies is kept from the file already there, and the file comes out
 * the same each time; the server test fails when it doesn't match what this
 * writes.
 */
import {
  createECDH,
  createPrivateKey,
  createPublicKey,
  createHash,
  sign,
  verify,
} from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const FIXTURES = fileURLToPath(
  new URL('../native/android/app/src/test/resources/alerts-fixtures.json', import.meta.url)
)

// ---------------------------------------------------------------------------
// People, channels, messages
// ---------------------------------------------------------------------------

const SAM = { id: 'u-sam', name: 'Sam' }
const ALEX = { id: 'u-alex', name: 'Alex (Stage 2)' }
const JO = { id: 'u-jo', name: 'Jo' }

const FOH = { id: 'c-foh', name: 'foh', kind: 'public' }
const OLD = { id: 'c-old', name: 'old', kind: 'public', retired: true }
const DM = { id: 'c-dm', name: 'dm', kind: 'dm', memberIds: [SAM.id, JO.id] }

const T0 = 1_780_000_000_000

const message = (over) => ({
  id: 'm-1',
  channelId: FOH.id,
  seq: 10,
  authorId: JO.id,
  kind: 'text',
  body: 'doors in 10',
  createdAt: T0,
  ...over,
})

/** [name, message, channel, level, readSeq, expected kind for Sam or null]. */
const MESSAGE_CASES = [
  ['plain message at the default is nothing', message(), FOH, 'mentions', 0, null],
  ['plain message in a channel set to All', message(), FOH, 'all', 0, 'message'],
  ['plain message in a muted channel', message(), FOH, 'muted', 0, null],
  [
    'a name mentions its person',
    message({ body: '@Sam check FOH' }),
    FOH,
    'mentions',
    0,
    'mention',
  ],
  ['a name gets through a mute', message({ body: '@sam!' }), FOH, 'muted', 0, 'mention'],
  ['a longer name is somebody else', message({ body: '@Sammy check' }), FOH, 'all', 0, 'message'],
  ['@channel at the default', message({ body: '@channel doors' }), FOH, 'mentions', 0, 'everyone'],
  ['@channel muted', message({ body: '@channel doors' }), FOH, 'muted', 0, null],
  ['@allison is not everyone', message({ body: '@allison hi' }), FOH, 'mentions', 0, null],
  ['a DM at the default', message({ channelId: DM.id }), DM, 'mentions', 0, 'dm'],
  ['a muted DM', message({ channelId: DM.id }), DM, 'muted', 0, null],
  ['already read', message({ body: '@Sam' }), FOH, 'all', 10, null],
  ['read up to the one before', message({ body: '@Sam' }), FOH, 'all', 9, 'mention'],
  ['my own message', message({ authorId: SAM.id, body: '@Sam' }), FOH, 'all', 0, null],
  ['a retired channel', message({ channelId: OLD.id, body: '@Sam' }), OLD, 'all', 0, null],
  [
    'the box talking to itself',
    message({ authorId: null, kind: 'system', body: '#foh created by Jo' }),
    FOH,
    'all',
    0,
    null,
  ],
  [
    'the desk at the default',
    message({ authorId: null, kind: 'system', body: 'Changeover', origin: 'desk' }),
    FOH,
    'mentions',
    0,
    'desk',
  ],
  [
    'the desk in a muted channel',
    message({ authorId: null, kind: 'system', body: 'Changeover', origin: 'desk' }),
    FOH,
    'muted',
    0,
    null,
  ],
  [
    'a DM I am not in',
    message({ channelId: 'c-dm2' }),
    { id: 'c-dm2', name: 'dm', kind: 'dm', memberIds: [ALEX.id, JO.id] },
    'all',
    0,
    null,
  ],
]

const messages = () =>
  MESSAGE_CASES.map(([name, msg, channel, level, readSeq, expect]) => ({
    name,
    message: msg,
    channel,
    person: SAM,
    level,
    readSeq,
    expect,
  }))

/** [body, name, mentioned]. The page's test, the box's and the phones' agree on these. */
const MENTIONS = [
  ['@Sam can you check FOH', 'Sam', true],
  ['thanks @sam', 'Sam', true],
  ['(@Sam)', 'Sam', true],
  ['@Sammy can you check FOH', 'Sam', false],
  ['@Sam2', 'Sam', false],
  ['@all doors in 5', 'Sam', true],
  ['@Everyone doors', 'Sam', true],
  ['@channel.', 'Sam', true],
  ['@allison can you check FOH', 'Sam', false],
  ['@channels list', 'Sam', false],
  ['@alex (stage 2) cue', 'Alex (Stage 2)', true],
  ['@alex stage 2 cue', 'Alex (Stage 2)', false],
  ['@sam', '', false],
]

const mentions = () => MENTIONS.map(([body, name, expect]) => ({ body, name, expect }))

// ---------------------------------------------------------------------------
// The show log
// ---------------------------------------------------------------------------

const incident = (over) => ({
  id: 'i-1',
  seq: 1,
  authorId: JO.id,
  authorName: 'Jo',
  kind: 'show-stop',
  severity: 'serious',
  body: 'Crowd surge at the barrier',
  at: T0,
  loggedAt: T0 + 2 * 60_000,
  stage: 'Main Stage',
  actId: 'a-1',
  actName: 'The Hollows',
  ...over,
})

const INCIDENT_CASES = [
  ['a show stop logged at once', incident(), true],
  ['a hold', incident({ kind: 'hold' }), true],
  ['a delay', incident({ kind: 'delay' }), false],
  ['serious, but medical', incident({ kind: 'medical' }), false],
  ['a correction', incident({ amends: 'i-0' }), false],
  ['logged exactly fifteen minutes on', incident({ loggedAt: T0 + 15 * 60_000 }), true],
  ['logged the next morning', incident({ loggedAt: T0 + 4 * 60 * 60_000 }), false],
]

const incidents = () =>
  INCIDENT_CASES.map(([name, entry, expect]) => ({ name, incident: entry, expect }))

// ---------------------------------------------------------------------------
// Changeover calls
// ---------------------------------------------------------------------------

const act = (id, name, start, end, over = {}) => ({
  id,
  name,
  stage: 'Main Stage',
  date: '2026-07-10',
  start,
  end,
  changeover: 0,
  ...over,
})

const calls = () => [
  {
    name: 'a gap gets a changeover call and each set an on-in-5',
    acts: [act('a-1', 'Night Bus', '20:00', '21:00'), act('a-2', 'The Hollows', '21:30', '22:30')],
    day: '2026-07-10',
    expect: [
      { id: 'c:a-1:soon:2026-07-10:1200', due: 1195, title: 'Night Bus on in 5 min' },
      { id: 'c:a-2:soon:2026-07-10:1290', due: 1285, title: 'The Hollows on in 5 min' },
      { id: 'c:a-2:changeover:2026-07-10:1290', due: 1260, title: 'Changeover on Main Stage' },
    ],
  },
  {
    name: 'no changeover for a gap of zero or a set with no end',
    acts: [
      act('a-1', 'Night Bus', '20:00', '21:00'),
      act('a-2', 'The Hollows', '21:00', ''),
      act('a-3', 'Late Set', '23:30', '00:30'),
    ],
    day: '2026-07-10',
    expect: [
      { id: 'c:a-1:soon:2026-07-10:1200', due: 1195, title: 'Night Bus on in 5 min' },
      { id: 'c:a-2:soon:2026-07-10:1260', due: 1255, title: 'The Hollows on in 5 min' },
      { id: 'c:a-3:soon:2026-07-10:1410', due: 1405, title: 'Late Set on in 5 min' },
    ],
  },
  {
    name: 'across the 06:00 roll, 00:30 is the same night',
    acts: [act('a-1', 'Late Set', '23:30', '00:30'), act('a-2', 'Closer', '01:00', '02:00')],
    day: '2026-07-10',
    expect: [
      { id: 'c:a-1:soon:2026-07-10:1410', due: 1405, title: 'Late Set on in 5 min' },
      { id: 'c:a-2:soon:2026-07-10:1500', due: 1495, title: 'Closer on in 5 min' },
      { id: 'c:a-2:changeover:2026-07-10:1500', due: 1470, title: 'Changeover on Main Stage' },
    ],
  },
  {
    name: "another day's sets are not tonight's",
    acts: [act('a-1', 'Friday', '20:00', '21:00', { date: '2026-07-11' })],
    day: '2026-07-10',
    expect: [],
  },
]

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/** A P-256 key from a seed, as the box's identity key is shaped. */
function p256From(label) {
  const d = createHash('sha256').update(`crewbox alerts fixture key ${label}`).digest()
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(d)
  const point = ecdh.getPublicKey()
  const privateKey = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: d.toString('base64url'),
      x: point.subarray(1, 33).toString('base64url'),
      y: point.subarray(33).toString('base64url'),
    },
    format: 'jwk',
  })
  return { privateKey, publicKey: createPublicKey(privateKey), raw: point.toString('base64url') }
}

const KEY = p256From('A')
const EVENT_ID = 'evt-3f9c2a'
const HOST = '10.20.0.1:3000'
const NONCE = 'q2-4k7BnW1xY8Zp0aVcDeF'
const STATEMENT = `crewbox-identity-v1\n${EVENT_ID}\n${HOST}\n${NONCE}`

function signature() {
  const signs = (sig) =>
    verify(
      'sha256',
      Buffer.from(STATEMENT, 'utf8'),
      { key: KEY.publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(sig, 'base64url')
    )
  if (existsSync(FIXTURES)) {
    try {
      const kept = JSON.parse(readFileSync(FIXTURES, 'utf8')).signed?.signature
      if (typeof kept === 'string' && signs(kept)) return kept
    } catch {
      // A file that won't read is rewritten.
    }
  }
  return sign('sha256', Buffer.from(STATEMENT, 'utf8'), {
    key: KEY.privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url')
}

const signed = () => ({
  key: KEY.raw,
  eventId: EVENT_ID,
  host: HOST,
  nonce: NONCE,
  statement: STATEMENT,
  signature: signature(),
  /** The same, signed for another address: a phone must refuse it. */
  wrongHost: '10.20.0.99:3000',
})

/** The inputs each alert in the frames below is built from, for the server test. */
const alertInputs = () => ({
  mention: {
    message: message({ id: 'm-7', seq: 12, body: '@Sam can you check FOH' }),
    channel: FOH,
    kind: 'mention',
    authorName: 'Jo',
    quiet: false,
  },
  dm: {
    message: message({ id: 'm-8', channelId: DM.id, seq: 3, body: 'On my way' }),
    channel: DM,
    kind: 'dm',
    authorName: 'Jo',
    quiet: true,
  },
  desk: {
    message: message({
      id: 'm-9',
      seq: 13,
      authorId: null,
      kind: 'system',
      body: 'Changeover started',
      origin: 'desk',
    }),
    channel: FOH,
    kind: 'desk',
    authorName: '',
    quiet: false,
  },
  showStop: { incident: incident({ id: 'i-4' }), quiet: false },
  changeover: {
    acts: [act('a-1', 'Night Bus', '20:00', '21:00'), act('a-2', 'The Hollows', '21:30', '22:30')],
    day: '2026-07-10',
    id: 'c:a-2:changeover:2026-07-10:1290',
    at: T0 + 60 * 60_000,
    quiet: false,
  },
})

const ALERTS = {
  mention: {
    id: 'm:m-7',
    kind: 'mention',
    title: 'Jo in #foh',
    body: '@Sam can you check FOH',
    target: { kind: 'channel', channelId: 'c-foh' },
    thread: 'c-foh',
    quiet: false,
    urgent: false,
    at: T0,
    from: { id: 'u-jo', name: 'Jo' },
    seq: 12,
    channelName: 'foh',
  },
  dm: {
    id: 'm:m-8',
    kind: 'dm',
    title: 'Jo',
    body: 'On my way',
    target: { kind: 'channel', channelId: 'c-dm' },
    thread: 'c-dm',
    quiet: true,
    urgent: false,
    at: T0,
    from: { id: 'u-jo', name: 'Jo' },
    seq: 3,
  },
  desk: {
    id: 'm:m-9',
    kind: 'desk',
    title: 'Production desk in #foh',
    body: 'Changeover started',
    target: { kind: 'channel', channelId: 'c-foh' },
    thread: 'c-foh',
    quiet: false,
    urgent: false,
    at: T0,
    seq: 13,
    channelName: 'foh',
  },
  showStop: {
    id: 'i:i-4',
    kind: 'showStop',
    title: 'Show stop on Main Stage',
    body: 'Jo: Crowd surge at the barrier',
    target: { kind: 'showlog' },
    thread: 'showlog',
    quiet: false,
    urgent: true,
    at: T0 + 2 * 60_000,
  },
  changeover: {
    id: 'c:a-2:changeover:2026-07-10:1290',
    kind: 'changeover',
    title: 'Changeover on Main Stage',
    body: 'The Hollows on in 30 min',
    target: { kind: 'stage', stage: 'Main Stage' },
    thread: 'stage:Main Stage',
    quiet: false,
    urgent: true,
    at: T0 + 60 * 60_000,
  },
}

const T = T0 + 90 * 60_000

const STAGES = [
  {
    stage: 'Main Stage',
    onNow: { actId: 'a-1', name: 'Night Bus', start: T0, end: T0 + 60 * 60_000 },
    next: { actId: 'a-2', name: 'The Hollows', start: T0 + 90 * 60_000, end: T0 + 150 * 60_000 },
  },
]

const SETTINGS = { channels: { 'c-foh': 'all', 'c-dm': 'muted' }, stages: ['Main Stage'] }

const frames = () => ({
  box: {
    type: 'box',
    v: 1,
    eventId: EVENT_ID,
    signature: signed().signature,
    beatMs: 30000,
    t: T,
  },
  hello: {
    type: 'hello',
    token: 'tok-abc',
    since: T - 5 * 60_000,
    timeZone: 'Europe/London',
  },
  welcome: {
    type: 'welcome',
    t: T,
    settings: SETTINGS,
    catchUp: [ALERTS.dm, ALERTS.mention],
    more: 3,
    stages: STAGES,
  },
  alertMention: { type: 'alert', t: T, alert: ALERTS.mention },
  alertDm: { type: 'alert', t: T, alert: ALERTS.dm },
  alertDesk: { type: 'alert', t: T, alert: ALERTS.desk },
  alertShowStop: { type: 'alert', t: T, alert: ALERTS.showStop },
  alertChangeover: { type: 'alert', t: T, alert: ALERTS.changeover },
  read: { type: 'read', t: T, channelId: 'c-foh', seq: 12 },
  withdraw: { type: 'withdraw', t: T, ids: ['m:m-7', 'c:a-2:changeover:2026-07-10:1290'] },
  settings: { type: 'settings', t: T, settings: SETTINGS },
  stages: { type: 'stages', t: T, stages: STAGES },
  beat: { type: 'beat', t: T },
  /** A frame from a newer box: a phone skips it, never fails on it. */
  unknown: { type: 'somethingNew', t: T, extra: [1, 2, 3] },
})

export function fixtures() {
  return {
    about:
      'Written by scripts/alerts-fixtures.mjs; read by server/test/alerts.test.ts and the ' +
      "Android app's AlertsFixturesTest. docs/ALERTS.md describes each frame.",
    mentions: mentions(),
    messages: messages(),
    incidents: incidents(),
    calls: calls(),
    signed: signed(),
    alertInputs: alertInputs(),
    frames: frames(),
  }
}

export const render = () => `${JSON.stringify(fixtures(), null, 2)}\n`

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  writeFileSync(FIXTURES, render())
  console.log(`wrote ${FIXTURES}`)
}
