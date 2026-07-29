// @vitest-environment happy-dom
//
// The manager reads saved device ids out of localStorage on every join.

import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The two moments a crew member is left with nothing on screen.
 *
 * Both of them end with the voice bar unmounted — it renders nothing once
 * `channelId` is null — so whatever went wrong has to leave the manager as a
 * thrown error or a notice, or it reaches nobody at all. Reported from a real
 * MacBook: "a banner appears for a frame and then vanishes immediately", with
 * the actual reason sitting in the browser console.
 *
 * `livekit-client` is mocked because the failures worth pinning here are the
 * manager's own control flow, not the SDK's.
 */

type Handler = (...args: unknown[]) => void

/** Stand-in Room whose connect outcome and events the test drives. */
class FakeRoom {
  static connectBehaviour: 'ok' | 'fail' = 'ok'
  handlers = new Map<string, Handler[]>()
  state = 'disconnected'
  activeSpeakers: Array<{ identity: string }> = []
  remoteParticipants = new Map()
  localParticipant = {
    identity: 'me',
    isSpeaking: false,
    audioTrackPublications: new Map(),
    setMicrophoneEnabled: vi.fn(),
  }

  on(event: string, handler: Handler): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args)
  }

  async connect(): Promise<void> {
    if (FakeRoom.connectBehaviour === 'fail') {
      throw new Error('could not establish signal connection: Failed to fetch')
    }
    this.state = 'connected'
  }

  async startAudio(): Promise<void> {}

  async disconnect(): Promise<void> {
    this.state = 'disconnected'
    this.emit('disconnected')
  }
}

vi.mock('livekit-client', () => ({
  Room: FakeRoom,
  RoomEvent: {
    Disconnected: 'disconnected',
    Reconnecting: 'reconnecting',
    Reconnected: 'reconnected',
    TrackSubscribed: 'trackSubscribed',
    TrackUnsubscribed: 'trackUnsubscribed',
    ParticipantConnected: 'participantConnected',
    ParticipantDisconnected: 'participantDisconnected',
    ActiveSpeakersChanged: 'activeSpeakersChanged',
    ConnectionQualityChanged: 'connectionQualityChanged',
    LocalTrackPublished: 'localTrackPublished',
  },
  ConnectionQuality: { Excellent: 'excellent', Good: 'good', Poor: 'poor', Lost: 'lost' },
  ConnectionState: { Connected: 'connected', Disconnected: 'disconnected' },
  Track: { Kind: { Audio: 'audio' } },
}))

const { VoiceManager } = await import('./voice.ts')

describe('a join that fails has to say so', () => {
  beforeEach(() => {
    FakeRoom.connectBehaviour = 'ok'
  })

  it('throws, rather than swallowing the reason', async () => {
    // The bug this pins. The manager used to catch its own connect failure
    // and call reset() without rethrowing, so the store's joinVoice — which
    // owns the only toast anyone sees — had its catch block bypassed for
    // every connection failure. Its catch then only ever fired for a failed
    // *token* request, which is the rarer half of the problem.
    FakeRoom.connectBehaviour = 'fail'
    const manager = new VoiceManager(() => {})

    await expect(manager.join('chan-1', 'token', 'ws://nowhere')).rejects.toThrow(
      /signal connection/
    )
  })

  it('carries the real reason out, not a generic substitute', async () => {
    FakeRoom.connectBehaviour = 'fail'
    const manager = new VoiceManager(() => {})
    await expect(manager.join('chan-1', 'token', 'ws://nowhere')).rejects.toThrow(
      'could not establish signal connection: Failed to fetch'
    )
  })

  it('still tears the room down before rethrowing', async () => {
    // Rethrowing must not skip the cleanup: the published state has to go
    // back to idle or the voice bar stays up over a room that is gone.
    FakeRoom.connectBehaviour = 'fail'
    const states: Array<Record<string, unknown>> = []
    const manager = new VoiceManager((partial) => states.push({ ...partial }))
    await manager.join('chan-1', 'token', 'ws://nowhere').catch(() => {})

    expect(states.at(-1)).toMatchObject({ channelId: null, status: 'idle' })
  })
})

describe('being dropped off comms has to say so too', () => {
  beforeEach(() => {
    FakeRoom.connectBehaviour = 'ok'
  })

  it('notifies when the room drops on its own', async () => {
    // Worse than a failed join: a failed join is visibly nothing happening,
    // while this leaves someone believing they are still on the intercom.
    const notices: string[] = []
    const manager = new VoiceManager(
      () => {},
      (message) => notices.push(message)
    )
    await manager.join('chan-1', 'token', 'ws://box')

    const room = (manager as unknown as { room: FakeRoom }).room
    room.emit('disconnected')

    expect(notices).toEqual(['Voice dropped — you are no longer on the intercom'])
  })

  it('stays quiet when the user left on purpose', async () => {
    // The guard that makes the notice safe: leave() nulls `room` before
    // disconnecting, so the handler's identity check fails and a deliberate
    // exit says nothing. Without this, every normal leave would toast.
    const notices: string[] = []
    const manager = new VoiceManager(
      () => {},
      (message) => notices.push(message)
    )
    await manager.join('chan-1', 'token', 'ws://box')
    await manager.leave()

    expect(notices).toEqual([])
  })

  it('says nothing when a stale room from an earlier channel drops', async () => {
    // Switching channels disconnects the old room. That is not a dropout and
    // must not be announced as one.
    const notices: string[] = []
    const manager = new VoiceManager(
      () => {},
      (message) => notices.push(message)
    )
    await manager.join('chan-1', 'token', 'ws://box')
    const first = (manager as unknown as { room: FakeRoom }).room
    await manager.join('chan-2', 'token', 'ws://box')

    first.emit('disconnected')
    expect(notices).toEqual([])
  })
})
