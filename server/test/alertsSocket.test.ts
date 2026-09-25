import { createPublicKey, randomBytes, verify } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Alert, AlertsBoxFrame, AlertsWelcomeFrame, PublicConfig } from '@crewbox/shared'
import { identityStatement } from '../src/identity.ts'
import { Client, startBox, type Box } from './support/box.ts'

/**
 * `/ws/alerts`: a phone's connection to the box that decides what buzzes it
 * (docs/ALERTS.md). The box proves itself before the phone sends a token,
 * then sends finished alerts, takes back what is no longer true, and drops a
 * phone that goes quiet.
 */

type Frame = { type: string; [key: string]: unknown }

let box: Box
const clients: { close(): void }[] = []
beforeEach(async () => {
  box = await startBox({ alertsBeatMs: 100 })
})
afterEach(async () => {
  for (const client of clients.splice(0)) client.close()
  await box.stop()
})

const nonce = () => randomBytes(16).toString('base64url')

async function openAlerts(
  challenge = nonce()
): Promise<{ client: Client<Frame>; box: AlertsBoxFrame; challenge: string }> {
  const client = new Client<Frame>(`ws://127.0.0.1:${box.port}/ws/alerts?nonce=${challenge}`)
  clients.push(client)
  await client.open()
  const first = await client.waitFor<AlertsBoxFrame>((m) => m.type === 'box')
  return { client, box: first, challenge }
}

async function signIn(
  token: string,
  since: number | null = null
): Promise<{ client: Client<Frame>; welcome: AlertsWelcomeFrame }> {
  const { client } = await openAlerts()
  client.send({ type: 'hello', token, since, timeZone: 'Europe/London' })
  const welcome = await client.waitFor<AlertsWelcomeFrame>((m) => m.type === 'welcome')
  return { client, welcome }
}

const config = async (): Promise<PublicConfig> =>
  (await box.app.inject({ method: 'GET', url: '/api/config' })).json() as PublicConfig

const general = () => box.store.getChannelByName('general')!

describe('the first frame', () => {
  it('is the event, signed over the challenge as GET /api/identity signs', async () => {
    const { box: first, challenge } = await openAlerts()
    const { eventId, eventKey } = await config()
    expect(first.eventId).toBe(eventId)
    expect(first.v).toBe(1)
    expect(first.beatMs).toBe(100)
    const point = Buffer.from(eventKey!, 'base64url')
    const key = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: point.subarray(1, 33).toString('base64url'),
        y: point.subarray(33).toString('base64url'),
      },
      format: 'jwk',
    })
    const signs = (host: string) =>
      verify(
        'sha256',
        identityStatement(eventId!, host, challenge),
        { key, dsaEncoding: 'ieee-p1363' },
        Buffer.from(first.signature!, 'base64url')
      )
    expect(signs(`127.0.0.1:${box.port}`)).toBe(true)
    // For the address the phone asked at, and no other.
    expect(signs(`10.20.0.1:${box.port}`)).toBe(false)
  })

  it('comes before the box has heard anything, so no token is sent unchecked', async () => {
    const { client } = await openAlerts()
    expect(client.received).toEqual([])
  })

  it('needs a challenge that is one', async () => {
    const client = new Client(`ws://127.0.0.1:${box.port}/ws/alerts?nonce=short`)
    await expect(client.open()).rejects.toThrow('HTTP 400')
    const none = new Client(`ws://127.0.0.1:${box.port}/ws/alerts`)
    await expect(none.open()).rejects.toThrow('HTTP 400')
  })

  it('is announced in /api/config', async () => {
    expect((await config()).alerts).toBe(1)
  })
})

describe('signing in', () => {
  it('closes with 4001 for a dead session', async () => {
    const { client } = await openAlerts()
    client.send({ type: 'hello', token: 'not-a-session', since: null })
    expect(await client.closed()).toBe(4001)
  })

  it('welcomes with settings, and no catch-up on a first connection', async () => {
    const jo = await box.join('Jo')
    const sam = await box.join('Sam')
    const { client: joChat } = await box.chat(jo)
    joChat.send({
      type: 'send',
      clientMsgId: 'aaaaaaaa1',
      channelId: general().id,
      body: '@Sam hi',
    })
    await joChat.waitFor((m) => m.type === 'ack')
    const { welcome } = await signIn(sam)
    expect(welcome.settings).toEqual({ channels: {}, stages: [] })
    expect(welcome.catchUp).toEqual([])
    expect(welcome.more).toBe(0)
    expect(welcome.stages).toEqual([])
  })

  it('counts as online, as the chat socket does', async () => {
    const sam = await box.join('Sam')
    expect(box.app.hub.stats().onlineUsers).toBe(0)
    const { client } = await signIn(sam)
    expect(box.app.hub.stats().onlineUsers).toBe(1)
    client.close()
    await client.closed()
    const deadline = Date.now() + 1000
    while (box.app.hub.stats().onlineUsers !== 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(box.app.hub.stats().onlineUsers).toBe(0)
  })
})

describe('alerts as they happen', () => {
  it('reach the phone and the page, following the rules', async () => {
    const jo = await box.join('Jo')
    const sam = await box.join('Sam')
    const { client: joChat } = await box.chat(jo)
    const { client: samPage } = await box.chat(sam)
    const { client: phone } = await signIn(sam)

    // Plain chatter at the default: nothing.
    joChat.send({ type: 'send', clientMsgId: 'aaaaaaaa1', channelId: general().id, body: 'hi' })
    // A mention: an alert, on both.
    joChat.send({
      type: 'send',
      clientMsgId: 'aaaaaaaa2',
      channelId: general().id,
      body: '@Sam check FOH',
    })
    const onPhone = await phone.waitFor<{ type: 'alert'; alert: Alert; t: number }>(
      (m) => m.type === 'alert'
    )
    expect(onPhone.alert).toMatchObject({
      kind: 'mention',
      title: 'Jo in #general',
      body: '@Sam check FOH',
      quiet: false,
      target: { kind: 'channel', channelId: general().id },
    })
    expect(typeof onPhone.t).toBe('number')
    const onPage = await samPage.waitFor<{ type: 'alert'; alert: Alert }>((m) => m.type === 'alert')
    expect(onPage.alert).toEqual(onPhone.alert)
    expect(phone.all('alert')).toEqual([])
    // The author hears nothing of their own.
    expect(joChat.all('alert')).toEqual([])
  })

  it('sound once a channel per 30 seconds, and arrive quiet after', async () => {
    const jo = await box.join('Jo')
    const sam = await box.join('Sam')
    const { client: joChat } = await box.chat(jo)
    const { client: phone } = await signIn(sam)
    for (const [i, body] of ['@Sam one', '@Sam two'].entries()) {
      joChat.send({ type: 'send', clientMsgId: `bbbbbbbb${i}`, channelId: general().id, body })
    }
    const first = await phone.waitFor<{ type: 'alert'; alert: Alert }>((m) => m.type === 'alert')
    const second = await phone.waitFor<{ type: 'alert'; alert: Alert }>((m) => m.type === 'alert')
    expect([first.alert.quiet, second.alert.quiet]).toEqual([false, true])
  })

  it("buzz for the desk, which nobody's pocket heard before", async () => {
    const sam = await box.join('Sam')
    const { client: phone } = await signIn(sam)
    const { controlKey } = await import('../src/control.ts')
    await box.app.inject({
      method: 'POST',
      url: '/api/control/message',
      headers: { 'x-api-key': controlKey(box.store, {}) },
      payload: { channel: 'general', body: 'Changeover started' },
    })
    const desk = await phone.waitFor<{ type: 'alert'; alert: Alert }>((m) => m.type === 'alert')
    expect(desk.alert).toMatchObject({
      kind: 'desk',
      title: 'Production desk in #general',
      body: 'Changeover started',
    })
    expect(desk.alert.from).toBeUndefined()
  })

  it('are taken back when read on another device', async () => {
    const jo = await box.join('Jo')
    const sam = await box.join('Sam')
    const { client: joChat } = await box.chat(jo)
    const { client: laptop } = await box.chat(sam)
    const { client: phone } = await signIn(sam)
    joChat.send({ type: 'send', clientMsgId: 'cccccccc1', channelId: general().id, body: '@Sam' })
    const alert = await phone.waitFor<{ type: 'alert'; alert: Alert }>((m) => m.type === 'alert')
    laptop.send({ type: 'markRead', channelId: general().id, seq: alert.alert.seq! })
    const read = await phone.waitFor<{ type: 'read'; channelId: string; seq: number }>(
      (m) => m.type === 'read'
    )
    expect(read).toMatchObject({ channelId: general().id, seq: alert.alert.seq })
  })

  it('are withdrawn when the message is deleted', async () => {
    const sam = await box.join('Sam')
    const { client: phone } = await signIn(sam)
    const { message } = box.store.appendMessage({
      channelId: general().id,
      authorId: null,
      kind: 'system',
      body: 'x',
    })
    box.app.hub.announceDeleted(general().id, message.id)
    const withdrawn = await phone.waitFor<{ type: 'withdraw'; ids: string[] }>(
      (m) => m.type === 'withdraw'
    )
    expect(withdrawn.ids).toEqual([`m:${message.id}`])
  })

  it("follow somebody's settings from their other devices", async () => {
    const sam = await box.join('Sam')
    const { client: laptop } = await box.chat(sam)
    const { client: phone } = await signIn(sam)
    laptop.send({ type: 'setChannelAlerts', channelId: general().id, level: 'all' })
    const settings = await phone.waitFor<{ type: 'settings'; settings: unknown }>(
      (m) => m.type === 'settings'
    )
    expect(settings.settings).toEqual({ channels: { [general().id]: 'all' }, stages: [] })

    const jo = await box.join('Jo')
    const { client: joChat } = await box.chat(jo)
    joChat.send({ type: 'send', clientMsgId: 'dddddddd1', channelId: general().id, body: 'hi' })
    const alert = await phone.waitFor<{ type: 'alert'; alert: Alert }>((m) => m.type === 'alert')
    expect(alert.alert.kind).toBe('message')
  })

  it('close when the account goes', async () => {
    const sam = await box.join('Sam')
    const { client: phone } = await signIn(sam)
    box.app.hub.disconnectUser(box.store.getUserByName('Sam')!.id)
    expect(await phone.closed()).toBe(4001)
  })
})

describe('coming back', () => {
  it('catches up on what was missed, sounding once', async () => {
    const jo = await box.join('Jo')
    const sam = await box.join('Sam')
    const since = Date.now()
    const { client: joChat } = await box.chat(jo)
    const dm = box.store.getOrCreateDm(
      box.store.getUserByName('Jo')!.id,
      box.store.getUserByName('Sam')!.id
    )
    joChat.send({ type: 'send', clientMsgId: 'eeeeeeee1', channelId: general().id, body: '@Sam' })
    await joChat.waitFor((m) => m.type === 'ack')
    joChat.send({ type: 'send', clientMsgId: 'eeeeeeee2', channelId: dm.id, body: 'where are you' })
    await joChat.waitFor((m) => m.type === 'ack')
    joChat.send({ type: 'send', clientMsgId: 'eeeeeeee3', channelId: general().id, body: 'hi' })
    await joChat.waitFor((m) => m.type === 'ack')

    const { welcome } = await signIn(sam, since)
    expect(welcome.catchUp.map((a) => [a.kind, a.body, a.quiet])).toEqual([
      ['mention', '@Sam', true],
      ['dm', 'where are you', false],
    ])
    expect(welcome.more).toBe(0)
  })

  it('leaves out what was read meanwhile', async () => {
    const jo = await box.join('Jo')
    const sam = await box.join('Sam')
    const since = Date.now()
    const { client: joChat } = await box.chat(jo)
    joChat.send({ type: 'send', clientMsgId: 'ffffffff1', channelId: general().id, body: '@Sam' })
    const ack = await joChat.waitFor<{ type: 'ack'; message: { seq: number } }>(
      (m) => m.type === 'ack'
    )
    box.store.setReadState(box.store.getUserByName('Sam')!.id, general().id, ack.message.seq)
    const { welcome } = await signIn(sam, since)
    expect(welcome.catchUp).toEqual([])
  })
})

describe('heartbeats', () => {
  it('come every beatMs, and a phone that answers stays', async () => {
    const sam = await box.join('Sam')
    const { client } = await signIn(sam)
    for (let i = 0; i < 5; i++) {
      const beat = await client.waitFor<{ type: 'beat'; t: number }>((m) => m.type === 'beat')
      client.send({ type: 'beat', t: beat.t })
    }
    expect(client.ws.readyState).toBe(client.ws.OPEN)
  })

  it('close a socket that has gone quiet for three', async () => {
    const { client } = await openAlerts()
    // Never answers.
    expect(await client.closed(2000)).toBe(1006)
  })
})
