import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AlertSettings, Message } from '@crewbox/shared'
import { openDb, runMigrations } from '../src/db.ts'
import { Store } from '../src/store.ts'
import { controlKey } from '../src/control.ts'
import { startBox, type Box } from './support/box.ts'

/**
 * What the box keeps so it can decide who a phone buzzes for
 * (docs/ALERTS.md): desk messages marked as the desk's, and each person's
 * setting per channel and the stages they follow.
 */

let box: Box
beforeEach(async () => {
  box = await startBox()
})
afterEach(async () => {
  await box.stop()
})

type Frame = { type: string; settings?: AlertSettings; message?: Message }

describe("the desk's messages", () => {
  it("are marked as the desk's, and the box's own are not", async () => {
    const token = await box.join('Sam')
    const { client } = await box.chat(token)
    const res = await box.app.inject({
      method: 'POST',
      url: '/api/control/message',
      headers: { 'x-api-key': controlKey(box.store, {}) },
      payload: { channel: 'general', body: 'Changeover started' },
    })
    expect(res.statusCode).toBe(200)
    const live = await client.waitFor<Frame>(
      (m) => m.type === 'msg' && (m as Frame).message?.body === 'Changeover started'
    )
    expect(live.message!.origin).toBe('desk')
    expect(live.message!.kind).toBe('system')

    // Read back from the database, as a reconnecting phone gets it.
    const general = box.store.getChannelByName('general')!
    const stored = box.store.listAfter(general.id, 0, 50)
    expect(stored.find((m) => m.body === 'Changeover started')!.origin).toBe('desk')
    // "Sam joined" is the box's own, and stays unmarked.
    expect(stored.find((m) => m.body === 'Sam joined')!.origin).toBeUndefined()
  })
})

describe("each person's alert settings", () => {
  it('start at Mentions for every channel, and no stages', async () => {
    const { welcome } = await box.chat(await box.join('Sam'))
    expect(welcome.alertSettings).toEqual({ channels: {}, stages: [] })
  })

  it("reach the person's other devices, and nobody else's", async () => {
    const sam = await box.join('Sam')
    const jo = await box.join('Jo')
    const phone = (await box.chat(sam)).client
    const laptop = (await box.chat(sam)).client
    const other = (await box.chat(jo)).client
    const general = box.store.getChannelByName('general')!

    phone.send({ type: 'setChannelAlerts', channelId: general.id, level: 'all' })
    const onLaptop = await laptop.waitFor<Frame>((m) => m.type === 'alertSettings')
    expect(onLaptop.settings).toEqual({ channels: { [general.id]: 'all' }, stages: [] })
    // The device that changed it hears back too, which is its confirmation.
    await phone.waitFor((m) => m.type === 'alertSettings')

    phone.send({ type: 'followStage', stage: 'Main Stage', follow: true })
    const followed = await laptop.waitFor<Frame>((m) => m.type === 'alertSettings')
    expect(followed.settings!.stages).toEqual(['Main Stage'])

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(other.all('alertSettings')).toEqual([])

    // And the next welcome carries them.
    const { welcome } = await box.chat(sam)
    expect(welcome.alertSettings).toEqual({
      channels: { [general.id]: 'all' },
      stages: ['Main Stage'],
    })
  })

  it('go back to the default without keeping a row that says so', async () => {
    const sam = await box.join('Sam')
    const { client } = await box.chat(sam)
    const general = box.store.getChannelByName('general')!
    client.send({ type: 'setChannelAlerts', channelId: general.id, level: 'muted' })
    await client.waitFor((m) => m.type === 'alertSettings')
    client.send({ type: 'setChannelAlerts', channelId: general.id, level: 'mentions' })
    const back = await client.waitFor<Frame>((m) => m.type === 'alertSettings')
    expect(back.settings!.channels).toEqual({})
  })

  it('never make somebody a member of a DM they are not in', async () => {
    const sam = await box.join('Sam')
    const jo = await box.join('Jo')
    const alex = await box.join('Alex')
    const joId = box.store.getUserByName('Jo')!.id
    const alexId = box.store.getUserByName('Alex')!.id
    const dm = box.store.getOrCreateDm(joId, alexId)
    void jo
    void alex

    const { client } = await box.chat(sam)
    client.send({ type: 'setChannelAlerts', channelId: dm.id, level: 'all' })
    const refused = await client.waitFor<Frame & { code?: string }>((m) => m.type === 'error')
    expect(refused.code).toBe('not_found')
    const samId = box.store.getUserByName('Sam')!.id
    expect(box.store.isMember(dm.id, samId)).toBe(false)
    expect(box.store.getAlertSettings(samId).channels).toEqual({})
  })

  it('go with the account', async () => {
    const sam = await box.join('Sam')
    const { client } = await box.chat(sam)
    client.send({ type: 'followStage', stage: 'Tent', follow: true })
    await client.waitFor((m) => m.type === 'alertSettings')
    const samId = box.store.getUserByName('Sam')!.id
    box.store.deleteUser(samId)
    expect(box.store.getAlertSettings(samId)).toEqual({ channels: {}, stages: [] })
  })

  it('refuse a level that is not one', async () => {
    const { client } = await box.chat(await box.join('Sam'))
    const general = box.store.getChannelByName('general')!
    client.send({ type: 'setChannelAlerts', channelId: general.id, level: 'loud' })
    const refused = await client.waitFor<Frame & { code?: string }>((m) => m.type === 'error')
    expect(refused.code).toBe('bad_request')
  })
})

describe('migration v14', () => {
  it('keeps where a message came from', () => {
    const store = new Store(openDb(':memory:'))
    const channel = store.createChannel('foh', 'public')
    const { message } = store.appendMessage({
      channelId: channel.id,
      authorId: null,
      kind: 'system',
      body: 'Doors',
      origin: 'desk',
    })
    expect(store.getMessageById(message.id)!.origin).toBe('desk')
  })

  it('runs again over itself without stopping the box', () => {
    const db = openDb(':memory:')
    db.exec('PRAGMA user_version = 13')
    expect(() => runMigrations(db)).not.toThrow()
  })
})
