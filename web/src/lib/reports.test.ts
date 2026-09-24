// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_OUTBOX,
  REPORT_OUTBOX_KEY,
  clientOs,
  crashQuestion,
  describeCrash,
  flushDeviceOutbox,
  scrubClient,
  sendCrash,
  sendFeedback,
  waitingOnDevice,
} from './reports.ts'

/**
 * The phone's half of crash reports and feedback: what it sends to the box,
 * what it keeps when the box is out of reach, and that nothing goes without
 * somebody pressing Send (there is no code path here that sends on its own —
 * the error screen and the feedback form are the only callers).
 */

interface Call {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

let calls: Call[] = []
let answer: () => Promise<Response>

beforeEach(() => {
  calls = []
  localStorage.clear()
  answer = () => Promise.resolve(new Response('{"ok":true}', { status: 202 }))
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    })
    return answer()
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('what platform this is', () => {
  it('believes the native shell first, then the user agent', () => {
    expect(clientOs('Mozilla/5.0 (Linux; Android 14)', 'ios')).toBe('ios')
    expect(clientOs('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', undefined)).toBe(
      'ios'
    )
    expect(clientOs('Mozilla/5.0 (Linux; Android 14; Pixel 8)', undefined)).toBe('android')
    expect(clientOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6)', undefined)).toBe('web')
  })
})

describe('scrubbing on the phone', () => {
  it('drops query strings, folds the box address and removes addresses', () => {
    expect(
      scrubClient(
        'at https://10.0.0.2:8787/assets/app.js?token=abc:1:2 from sam@example.com',
        'https://10.0.0.2:8787'
      )
    ).toBe('at <box>/assets/app.js from <email>')
    expect(scrubClient('fetch http://192.168.1.9/x failed')).toBe('fetch http://<ip>/x failed')
  })

  it('builds the report the error screen offers, with the component stack', () => {
    const crash = describeCrash(
      new TypeError('cannot read x'),
      '\n    at ChannelView\n    at Main',
      '1.0.0+abc1234',
      'http://box.local'
    )
    expect(crash.summary).toBe('TypeError: cannot read x')
    expect(crash.version).toBe('1.0.0+abc1234')
    expect(crash.detail).toContain('Component stack:')
    expect(crash.detail).toContain('at ChannelView')
    expect(Object.keys(crash).sort()).toEqual(['detail', 'os', 'summary', 'version'])
  })

  it('copes with something thrown that is not an Error', () => {
    expect(describeCrash('just a string', undefined, '1.0.0').summary).toBe('Error: just a string')
  })
})

describe('sending feedback', () => {
  it('goes to the box, as typed, with the session', async () => {
    const outcome = await sendFeedback(
      { type: 'idea', message: 'A cue light', public: false },
      'session-token'
    )
    expect(outcome).toBe('sent')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toMatch(/\/api\/reports\/feedback$/)
    expect(calls[0].headers.authorization).toBe('Bearer session-token')
    expect(calls[0].body).toMatchObject({ type: 'idea', message: 'A cue light', public: false })
    expect(calls[0].headers).not.toHaveProperty('x-admin-token')
  })

  it('carries the admin unlock only when the licence was ticked', async () => {
    await sendFeedback({ type: 'bug', message: 'x', includeLicence: true }, 't', 'admin-t')
    expect(calls[0].headers['x-admin-token']).toBe('admin-t')
    await sendFeedback({ type: 'bug', message: 'x', includeLicence: false }, 't', 'admin-t')
    expect(calls[1].headers).not.toHaveProperty('x-admin-token')
  })

  it('keeps it on the device when the box cannot be reached, and hands it over later', async () => {
    answer = () => Promise.reject(new TypeError('Failed to fetch'))
    expect(
      await sendFeedback({ type: 'bug', message: 'kept', includeLicence: true }, 't', 'a')
    ).toBe('saved')
    expect(waitingOnDevice()).toBe(1)

    answer = () => Promise.resolve(new Response('{"ok":true}', { status: 202 }))
    expect(await flushDeviceOutbox('t')).toBe(1)
    expect(waitingOnDevice()).toBe(0)
    const handed = calls.at(-1)!
    expect(handed.body).toMatchObject({ message: 'kept', includeLicence: false })
  })

  it('shows a refusal instead of keeping something the box will always refuse', async () => {
    answer = () =>
      Promise.resolve(new Response('{"error":"Write something first."}', { status: 400 }))
    expect(await sendFeedback({ type: 'bug', message: ' ' }, 't')).toEqual({
      refused: 'Write something first.',
    })
    expect(waitingOnDevice()).toBe(0)
  })

  it('keeps it for a box too old to have the route', async () => {
    answer = () => Promise.resolve(new Response('{}', { status: 404 }))
    expect(await sendFeedback({ type: 'bug', message: 'x' }, 't')).toBe('saved')
  })

  it(`holds at most ${MAX_OUTBOX} on a phone`, async () => {
    answer = () => Promise.reject(new TypeError('Failed to fetch'))
    for (let i = 0; i < MAX_OUTBOX + 3; i++)
      await sendFeedback({ type: 'bug', message: `m${i}` }, 't')
    const kept = JSON.parse(localStorage.getItem(REPORT_OUTBOX_KEY) ?? '[]') as Array<{
      body: { message: string }
    }>
    expect(kept).toHaveLength(MAX_OUTBOX)
    expect(kept[0].body.message).toBe('m3')
  })

  it('stops handing over at the first report the box still cannot take', async () => {
    answer = () => Promise.reject(new TypeError('Failed to fetch'))
    await sendFeedback({ type: 'bug', message: 'a' }, 't')
    await sendFeedback({ type: 'bug', message: 'b' }, 't')
    expect(await flushDeviceOutbox('t')).toBe(0)
    expect(waitingOnDevice()).toBe(2)
  })
})

describe('sending a crash report', () => {
  it('goes to the box when pressed, and is kept when the box is away', async () => {
    const crash = describeCrash(new Error('boom'), undefined, '1.0.0')
    expect(await sendCrash(crash, 't')).toBe('sent')
    expect(calls[0].url).toMatch(/\/api\/reports\/crash$/)
    answer = () => Promise.reject(new TypeError('Failed to fetch'))
    expect(await sendCrash(crash, 't')).toBe('saved')
    expect(waitingOnDevice()).toBe(1)
  })
})

describe('the question after a crash', () => {
  it('uses the exact words for an unclean exit', () => {
    expect(crashQuestion([{ kind: 'unclean-exit' }])).toBe(
      'Crewbox closed unexpectedly last time. Send a crash report to LeTissier Creative Studios?'
    )
  })

  it('asks about an error the box survived, and nothing when nothing waits', () => {
    expect(crashQuestion([{ kind: 'exception' }])).toMatch(/kept running/)
    expect(crashQuestion([])).toBeNull()
  })
})
