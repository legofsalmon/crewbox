import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AlertsWelcomeFrame, Cue, Panic } from '@crewbox/shared'
import { Client, startBox, type Box } from './support/box.ts'

/**
 * Cue lights and the panic button over the sockets: the chat socket carries
 * the presses and the state, the alerts socket buzzes the phones
 * (docs/CUES.md).
 */

type Frame = { type: string; [key: string]: unknown }

let box: Box
const clients: { close(): void }[] = []
beforeEach(async () => {
  box = await startBox({ alertsBeatMs: 1000 })
})
afterEach(async () => {
  for (const client of clients.splice(0)) client.close()
  await box.stop()
})

async function phone(
  token: string,
  since: number | null = null
): Promise<{ client: Client<Frame>; welcome: AlertsWelcomeFrame }> {
  const nonce = randomBytes(16).toString('base64url')
  const client = new Client<Frame>(`ws://127.0.0.1:${box.port}/ws/alerts?nonce=${nonce}`)
  clients.push(client)
  await client.open()
  await client.waitFor((m) => m.type === 'box')
  client.send({ type: 'hello', token, since, timeZone: 'Europe/London' })
  const welcome = await client.waitFor<AlertsWelcomeFrame>((m) => m.type === 'welcome')
  return { client, welcome }
}

const userId = (name: string) => box.store.listUsers().find((u) => u.name === name)!.id

describe('a cue light over the sockets', () => {
  it('is called, answered and sent, and the operator’s phone rings for standby and GO', async () => {
    const sam = await box.join('Sam')
    const jo = await box.join('Jo')
    const { client: samChat } = await box.chat(sam)
    const { client: joChat } = await box.chat(jo)
    const { client: joPhone } = await phone(jo)

    samChat.send({ type: 'cueStandby', targetId: userId('Jo'), label: 'Pyro 1', stage: '' })
    const called = (await joChat.waitFor<{ cue: Cue }>((m) => m.type === 'cue')).cue
    expect(called).toMatchObject({ label: 'Pyro 1', state: 'standby', caller: { name: 'Sam' } })
    const standby = await joPhone.waitFor<{ alert: { id: string; title: string } }>(
      (m) => m.type === 'alert'
    )
    expect(standby.alert).toMatchObject({ id: `q:${called.id}`, title: 'Standby: Pyro 1' })

    joChat.send({ type: 'cueStep', cueId: called.id, step: 'ready' })
    await samChat.waitFor((m) => m.type === 'cue' && (m.cue as Cue).state === 'ready')

    samChat.send({ type: 'cueStep', cueId: called.id, step: 'go' })
    const go = await joPhone.waitFor<{ alert: { id: string; title: string; quiet: boolean } }>(
      (m) => m.type === 'alert'
    )
    // Inside 30 seconds of the standby, and still sounding.
    expect(go.alert).toMatchObject({ id: `q:${called.id}`, title: 'GO: Pyro 1', quiet: false })
  })

  it('refuses a standing-by from anybody but the operator, in words', async () => {
    const sam = await box.join('Sam')
    await box.join('Jo')
    const { client: samChat } = await box.chat(sam)
    samChat.send({ type: 'cueStandby', targetId: userId('Jo'), label: 'VT', stage: '' })
    const { cue } = await samChat.waitFor<{ cue: Cue }>((m) => m.type === 'cue')
    samChat.send({ type: 'cueStep', cueId: cue.id, step: 'ready' })
    const error = await samChat.waitFor<{ message: string }>((m) => m.type === 'error')
    expect(error.message).toBe('Only the person on standby can say they are standing by.')
  })

  it('is in the welcome of a device that joins while it is lit', async () => {
    const sam = await box.join('Sam')
    const jo = await box.join('Jo')
    const { client: samChat } = await box.chat(sam)
    samChat.send({ type: 'cueStandby', targetId: userId('Jo'), label: 'CO2', stage: '' })
    await samChat.waitFor((m) => m.type === 'cue')
    const { welcome } = await box.chat(jo)
    expect(welcome.cues?.map((c) => c.label)).toEqual(['CO2'])
    expect(welcome.panics).toEqual([])
  })

  it('rings a phone that was away when the standby was called', async () => {
    const sam = await box.join('Sam')
    const jo = await box.join('Jo')
    const { client: samChat } = await box.chat(sam)
    samChat.send({ type: 'cueStandby', targetId: userId('Jo'), label: 'Pyro 2', stage: '' })
    await samChat.waitFor((m) => m.type === 'cue')
    const { welcome } = await phone(jo, Date.now() - 60_000)
    expect(welcome.catchUp.map((a) => [a.title, a.quiet])).toEqual([['Standby: Pyro 2', false]])
  })
})

describe('the panic button over the sockets', () => {
  it('rings every other phone, posts in #general, and tells the caller who is coming', async () => {
    const jo = await box.join('Jo')
    const ali = await box.join('Ali')
    const { client: joChat } = await box.chat(jo)
    const { client: aliChat } = await box.chat(ali)
    const { client: aliPhone } = await phone(ali)
    const { client: joPhone } = await phone(jo)

    joChat.send({ type: 'panic' })
    const { panic } = await aliChat.waitFor<{ panic: Panic }>((m) => m.type === 'panic')
    const ring = await aliPhone.waitFor<{ alert: { kind: string; title: string; urgent: boolean } }>(
      (m) => m.type === 'alert'
    )
    expect(ring.alert).toMatchObject({ kind: 'panic', title: 'Jo needs help', urgent: true })
    const record = await aliChat.waitFor<{ message: { body: string; kind: string } }>(
      (m) => m.type === 'msg'
    )
    expect(record.message).toMatchObject({
      kind: 'system',
      body: '🆘 Jo held the panic button and needs help.',
    })

    aliChat.send({ type: 'panicStep', panicId: panic.id, step: 'respond' })
    const coming = await joPhone.waitFor<{ alert: { title: string } }>((m) => m.type === 'alert')
    expect(coming.alert.title).toBe('Ali is on the way')

    joChat.send({ type: 'panicStep', panicId: panic.id, step: 'stand-down' })
    const withdraw = await aliPhone.waitFor<{ ids: string[] }>((m) => m.type === 'withdraw')
    expect(withdraw.ids).toContain(`p:${panic.id}`)
    // Nobody's phone rang for their own call: the system message never alerts.
    expect(joPhone.all('alert').map((m) => (m.alert as { kind: string }).kind)).toEqual([])
  })
})
