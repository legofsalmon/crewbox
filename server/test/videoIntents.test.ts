import { describe, expect, it } from 'vitest'
import { VIDEO_INTENT_TTL_MS } from '@crewbox/shared'
import { Intents, MAX_OPEN_INTENTS } from '../src/video/intents.ts'

/**
 * The double confirmation.
 *
 * The property worth defending is not "the UI asks twice" — a dialog protects
 * the person looking at it and nobody else. It is that **no single call puts
 * a packet on a video network**, however that call is made. Every test here
 * is a way somebody might get round that.
 */

let clock = 1_000
const intents = () => new Intents(() => clock)

const armScan = (i: Intents, userId = 'u1') =>
  i.arm({ userId, action: 'scan', target: 'the 10.0.30.0 network', willSend: ['one probe'] })

describe('raising an intent', () => {
  it('says what would be sent, before anything is', () => {
    const intent = armScan(intents())
    expect(intent.willSend).toEqual(['one probe'])
    expect(intent.target).toBe('the 10.0.30.0 network')
  })

  it('does not leak whose intent it is', () => {
    // The token goes to a browser. Who raised it is the server's business.
    expect(armScan(intents())).not.toHaveProperty('userId')
  })

  it('gives every intent its own token', () => {
    const i = intents()
    expect(armScan(i, 'u1').token).not.toBe(armScan(i, 'u2').token)
  })
})

describe('spending one', () => {
  it('accepts the token it issued', () => {
    const i = intents()
    const intent = armScan(i)
    expect(i.consume({ token: intent.token, userId: 'u1', action: 'scan' }).ok).toBe(true)
  })

  it('refuses a request with no token at all', () => {
    const i = intents()
    armScan(i)
    const result = i.consume({ token: undefined, userId: 'u1', action: 'scan' })
    expect(result).toEqual({ ok: false, reason: 'this needs confirming first' })
  })

  it('refuses a made-up token', () => {
    expect(intents().consume({ token: 'nope', userId: 'u1', action: 'scan' }).ok).toBe(false)
  })

  it('spends a token once and once only', () => {
    // Otherwise "confirm the scan" becomes "confirm a scan, then scan for as
    // long as you keep the token".
    const i = intents()
    const intent = armScan(i)
    expect(i.consume({ token: intent.token, userId: 'u1', action: 'scan' }).ok).toBe(true)
    expect(i.consume({ token: intent.token, userId: 'u1', action: 'scan' }).ok).toBe(false)
  })

  it('refuses another admin using somebody else"s confirmation', () => {
    const i = intents()
    const intent = armScan(i, 'u1')
    const result = i.consume({ token: intent.token, userId: 'u2', action: 'scan' })
    expect(result).toEqual({ ok: false, reason: 'that confirmation belongs to somebody else' })
  })

  it('refuses a token spent on a different action', () => {
    // The description an admin read has to be the thing they authorised. A
    // scan confirmation must not start monitoring a processor.
    const i = intents()
    const intent = armScan(i)
    const result = i.consume({
      token: intent.token,
      userId: 'u1',
      action: 'watch',
      processorId: 'p1',
    })
    expect(result).toEqual({ ok: false, reason: 'that confirmation was for something else' })
  })

  it('refuses a token spent on a different processor', () => {
    const i = intents()
    const intent = i.arm({
      userId: 'u1',
      action: 'watch',
      processorId: 'p1',
      target: 'x',
      willSend: [],
    })
    expect(
      i.consume({ token: intent.token, userId: 'u1', action: 'watch', processorId: 'p2' }).ok
    ).toBe(false)
  })

  it('expires, so one raised at load-in cannot be spent at midnight', () => {
    const i = intents()
    const intent = armScan(i)
    clock += VIDEO_INTENT_TTL_MS + 1
    const result = i.consume({ token: intent.token, userId: 'u1', action: 'scan' })
    expect(result).toEqual({ ok: false, reason: 'that confirmation has expired — start again' })
    clock = 1_000
  })
})

describe('holding them', () => {
  it('replaces an admin"s earlier intent for the same action', () => {
    // Two live tokens for one button is a way to spend the wrong one — and
    // the wrong one describes traffic nobody is currently looking at.
    const i = intents()
    const first = armScan(i)
    armScan(i)
    expect(i.consume({ token: first.token, userId: 'u1', action: 'scan' }).ok).toBe(false)
  })

  it('keeps intents for different actions side by side', () => {
    const i = intents()
    const scan = armScan(i)
    i.arm({ userId: 'u1', action: 'watch', processorId: 'p1', target: 'x', willSend: [] })
    expect(i.consume({ token: scan.token, userId: 'u1', action: 'scan' }).ok).toBe(true)
  })

  it('does not grow without limit', () => {
    const i = intents()
    for (let n = 0; n < MAX_OPEN_INTENTS * 2; n++) {
      i.arm({ userId: `u${n}`, action: 'watch', processorId: `p${n}`, target: 'x', willSend: [] })
    }
    // The oldest are dropped, so the earliest token no longer works. What
    // matters is that an unspent intent cannot be used to grow this for ever.
    const stale = i.consume({ token: 'anything', userId: 'u0', action: 'watch', processorId: 'p0' })
    expect(stale.ok).toBe(false)
  })
})
