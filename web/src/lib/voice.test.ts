// @vitest-environment happy-dom
//
// The manager reads saved device ids out of localStorage on every join.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveDeviceId, savedDeviceId } from './devices.ts'

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
  /** Whether the browser lets this page make a noise without a gesture. */
  static playbackBehaviour: 'allowed' | 'blocked' = 'allowed'
  static disconnectCalls = 0
  /** What each connect was given: url, token and the options, if any. */
  static connectCalls: unknown[][] = []
  handlers = new Map<string, Handler[]>()
  state = 'disconnected'
  canPlaybackAudio = true
  activeSpeakers: Array<{ identity: string }> = []
  remoteParticipants = new Map()
  localParticipant = {
    identity: 'me',
    isSpeaking: false,
    audioTrackPublications: new Map(),
    setMicrophoneEnabled: vi.fn(),
    // No published track in the fake, so the level meter is a no-op — the
    // control flow under test is the mic enable/disable, not metering.
    getTrackPublication: vi.fn(() => undefined),
  }

  on(event: string, handler: Handler): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args)
  }

  async connect(...args: unknown[]): Promise<void> {
    FakeRoom.connectCalls.push(args)
    if (FakeRoom.connectBehaviour === 'fail') {
      // A real Room fires this on the way out of a failed connect, which is
      // the whole point of the test below.
      this.emit('disconnected')
      throw new Error('could not establish signal connection: Failed to fetch')
    }
    this.state = 'connected'
  }

  async startAudio(): Promise<void> {
    if (FakeRoom.playbackBehaviour === 'blocked') {
      this.canPlaybackAudio = false
      this.emit('audioPlaybackChanged')
      throw new Error('audio playback failed: NotAllowedError')
    }
    this.canPlaybackAudio = true
  }

  async disconnect(): Promise<void> {
    FakeRoom.disconnectCalls++
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
    AudioPlaybackStatusChanged: 'audioPlaybackChanged',
  },
  ConnectionQuality: { Excellent: 'excellent', Good: 'good', Poor: 'poor', Lost: 'lost' },
  ConnectionState: { Connected: 'connected', Disconnected: 'disconnected' },
  Track: { Kind: { Audio: 'audio' }, Source: { Microphone: 'microphone' } },
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

  it('does not say you were dropped from a call you never joined', async () => {
    // A failed connect fires Disconnected too, with `room` still set — so
    // every join against an unreachable SFU told the crew member they had
    // been dropped off the intercom they had never been on, on top of the
    // join error they were already being shown. Two toasts, one of them
    // false, and the false one is the alarming one.
    FakeRoom.connectBehaviour = 'fail'
    const notices: string[] = []
    const manager = new VoiceManager(
      () => {},
      (message) => notices.push(message)
    )
    await manager.join('chan-1', 'token', 'ws://nowhere').catch(() => {})

    expect(notices).toEqual([])
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

describe('the mic capture that happens on the way in', () => {
  beforeEach(() => {
    FakeRoom.connectBehaviour = 'ok'
  })

  it('leaves the mic open if the button went down while it was capturing', async () => {
    // The capture is enable-then-disable, and it takes a moment. A press
    // inside that window was undone by the disable — the button held down,
    // the mic shut, and nothing on screen saying so. The second call has to
    // honour whatever is being asked for by the time it runs.
    const manager = new VoiceManager(() => {})
    await manager.join('chan-1', 'token', 'ws://box')
    const room = (manager as unknown as { room: FakeRoom }).room
    const mic = room.localParticipant.setMicrophoneEnabled as ReturnType<typeof vi.fn>

    // Press while the acquisition is still in flight, then let it finish.
    mic.mockClear()
    ;(manager as unknown as { talking: boolean }).talking = true
    await (manager as unknown as { acquireMic: () => Promise<void> }).acquireMic()

    expect(mic).toHaveBeenLastCalledWith(true)
  })
})

describe('the devices a browser will admit to', () => {
  beforeEach(() => {
    FakeRoom.connectBehaviour = 'ok'
    localStorage.clear()
  })

  it('does not forget the saved headset because the browser will not name it', async () => {
    // Before the microphone permission is granted, enumerateDevices returns
    // entries with blank ids — which the filter drops, leaving an empty
    // list. The fall-back logic read that as "your headset is gone" and
    // erased the crew member's choice, on every join, before they were even
    // asked for permission to use it.
    saveDeviceId('audioinput', 'my-headset')
    const devices = {
      enumerateDevices: async () => [{ kind: 'audioinput', deviceId: '', label: '' }],
    }
    Object.defineProperty(navigator, 'mediaDevices', { value: devices, configurable: true })

    const manager = new VoiceManager(() => {})
    await manager.refreshDevices()

    expect(savedDeviceId('audioinput')).toBe('my-headset')
  })

  it('still falls back loudly when the headset really is unplugged', async () => {
    saveDeviceId('audioinput', 'my-headset')
    const devices = {
      enumerateDevices: async () => [
        { kind: 'audioinput', deviceId: 'built-in', label: 'Built-in Microphone' },
      ],
    }
    Object.defineProperty(navigator, 'mediaDevices', { value: devices, configurable: true })

    const manager = new VoiceManager(() => {})
    await manager.refreshDevices()

    expect(savedDeviceId('audioinput')).toBeNull()
  })
})

describe('a push-to-talk release is never lost to a reconnect', () => {
  beforeEach(() => {
    FakeRoom.connectBehaviour = 'ok'
  })

  it('closes the mic even when the release lands mid-reconnect', async () => {
    // The hot-mic bug: the old setTalking returned early unless the room was
    // Connected, so a release arriving while the room was Reconnecting was
    // dropped — and LiveKit re-publishes the last enabled track on
    // reconnection, leaving a live mic the crew member believes they closed.
    const manager = new VoiceManager(() => {})
    await manager.join('chan-1', 'token', 'ws://box')
    const room = (manager as unknown as { room: FakeRoom }).room
    const mic = room.localParticipant.setMicrophoneEnabled

    await manager.setTalking(true)
    expect(mic).toHaveBeenLastCalledWith(true)

    // The network wobbles and LiveKit refuses the change mid-reconnect.
    room.state = 'reconnecting'
    room.emit('reconnecting')
    mic.mockRejectedValueOnce(new Error('cannot publish while reconnecting'))
    await manager.setTalking(false) // the release the old code silently dropped

    // On reconnection the intent is reconciled: the mic ends closed, not hot.
    room.state = 'connected'
    room.emit('reconnected')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mic).toHaveBeenLastCalledWith(false)
  })
})

describe('a browser that refuses to make a noise', () => {
  beforeEach(() => {
    FakeRoom.connectBehaviour = 'ok'
    FakeRoom.playbackBehaviour = 'allowed'
    FakeRoom.disconnectCalls = 0
  })

  it('is a state with a button on it, not a failed join', async () => {
    // Blocked autoplay is the ordinary first join on iOS. Treating it as a
    // failed join told the crew member the join failed while the room stayed
    // connected underneath — in the SFU, out of the UI, hearing nothing and
    // with no idea they might still be heard.
    FakeRoom.playbackBehaviour = 'blocked'
    const states: Array<Record<string, unknown>> = []
    const manager = new VoiceManager((partial) => states.push({ ...partial }))

    await expect(manager.join('chan-1', 'token', 'ws://box')).resolves.toBeUndefined()
    expect(states.some((s) => s.status === 'connected')).toBe(true)
  })

  it('raises the flag the tap-to-hear control hangs off', async () => {
    FakeRoom.playbackBehaviour = 'blocked'
    const states: Array<Record<string, unknown>> = []
    const manager = new VoiceManager((partial) => states.push({ ...partial }))
    await manager.join('chan-1', 'token', 'ws://box')

    expect(states.some((s) => s.audioBlocked === true)).toBe(true)
  })

  it('lowers it again once the tap gets through', async () => {
    FakeRoom.playbackBehaviour = 'blocked'
    const states: Array<Record<string, unknown>> = []
    const manager = new VoiceManager((partial) => states.push({ ...partial }))
    await manager.join('chan-1', 'token', 'ws://box')

    FakeRoom.playbackBehaviour = 'allowed'
    await manager.resumeAudio()

    expect(states.at(-1)).toMatchObject({ audioBlocked: false })
  })

  it('says nothing when the browser was never going to block it', async () => {
    const states: Array<Record<string, unknown>> = []
    const manager = new VoiceManager((partial) => states.push({ ...partial }))
    await manager.join('chan-1', 'token', 'ws://box')

    expect(states.some((s) => s.audioBlocked === true)).toBe(false)
  })
})

describe('a room nobody is holding any more', () => {
  beforeEach(() => {
    FakeRoom.connectBehaviour = 'ok'
    FakeRoom.playbackBehaviour = 'allowed'
    FakeRoom.disconnectCalls = 0
  })

  it('hangs up when the manager resets, rather than dropping the reference', async () => {
    // `reset` used to null the room without disconnecting. A join that failed
    // after connect had already succeeded left a live room with nothing
    // pointing at it: gone from their own screen, still in the participant
    // list, and arriving as a second device on the next join.
    const manager = new VoiceManager(() => {})
    await manager.join('chan-1', 'token', 'ws://box')
    const room = (manager as unknown as { room: FakeRoom }).room

    room.emit('disconnected')

    expect(FakeRoom.disconnectCalls).toBeGreaterThan(0)
  })

  it('does not hang up twice on a deliberate leave', async () => {
    const manager = new VoiceManager(() => {})
    await manager.join('chan-1', 'token', 'ws://box')
    await manager.leave()

    // leave() nulls the room before disconnecting, so reset() finds nothing
    // left to close — one hang-up, not two.
    expect(FakeRoom.disconnectCalls).toBe(1)
  })
})

describe('the STUN servers a phone asks', () => {
  beforeEach(() => {
    FakeRoom.connectBehaviour = 'ok'
    FakeRoom.playbackBehaviour = 'allowed'
    FakeRoom.connectCalls = []
  })

  it('asks none when the box says so, because the empty list reaches the SDK', async () => {
    // LiveKit hands every participant Twilio's and Google's STUN servers when
    // it has none of its own, and the SDK applies them unless
    // `rtcConfig.iceServers` is set. So the box's empty list has to arrive as
    // a list: dropped for being empty, it would put all three back.
    const manager = new VoiceManager(() => {})
    await manager.join('chan-1', 'token', 'ws://box', [])

    expect(FakeRoom.connectCalls.at(-1)).toEqual([
      'ws://box',
      'token',
      { rtcConfig: { iceServers: [] } },
    ])
  })

  it('leaves the list to an SFU the box does not run', async () => {
    // Somebody else's SFU may need its STUN or TURN servers to get through a
    // NAT, and only it knows which, so the box sends no list and the phone
    // passes no options at all.
    const manager = new VoiceManager(() => {})
    await manager.join('chan-1', 'token', 'wss://sfu.example')

    expect(FakeRoom.connectCalls.at(-1)).toEqual(['wss://sfu.example', 'token', undefined])
  })
})

describe('asking Android about a Bluetooth headset', () => {
  // The Android web view reads the Bluetooth permission once, when its audio
  // first starts. Asked after the join has opened audio, a yes would change
  // nothing until the app next starts afresh (VoicePlugin.java).

  beforeEach(() => {
    FakeRoom.connectBehaviour = 'ok'
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete window.Capacitor
  })

  /** A bridge whose answer the test gives, when it chooses to. */
  const askingBridge = () => {
    const pending = { answer: undefined as (() => void) | undefined }
    const prepare = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          pending.answer = resolve
        })
    )
    window.Capacitor = { Plugins: { CrewboxVoice: { prepare } } }
    return { prepare, pending }
  }

  it('happens before the join opens any audio, and waits for the answer', async () => {
    const { prepare, pending } = askingBridge()
    const connect = vi.spyOn(FakeRoom.prototype, 'connect')
    const manager = new VoiceManager(() => {})

    const joined = manager.join('chan-1', 'token', 'ws://box')
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce())
    expect(connect).not.toHaveBeenCalled()

    pending.answer?.()
    await joined
    expect(connect).toHaveBeenCalledOnce()
  })

  it('never costs the join, whatever the bridge does', async () => {
    // A headset that doesn't follow the call is a nuisance. A crew member
    // who can't get on comms because of it is a failure.
    window.Capacitor = {
      Plugins: { CrewboxVoice: { prepare: vi.fn(async () => Promise.reject(new Error('gone'))) } },
    }
    const states: Array<Record<string, unknown>> = []
    const manager = new VoiceManager((partial) => states.push({ ...partial }))

    await manager.join('chan-1', 'token', 'ws://box')
    expect(states).toContainEqual(expect.objectContaining({ status: 'connected' }))
  })

  it('does not carry on into a channel that was left while Android asked', async () => {
    const { pending } = askingBridge()
    const connect = vi.spyOn(FakeRoom.prototype, 'connect')
    const manager = new VoiceManager(() => {})

    const joined = manager.join('chan-1', 'token', 'ws://box')
    await vi.waitFor(() => expect(pending.answer).toBeTypeOf('function'))
    await manager.leave()
    pending.answer?.()
    await joined

    expect(connect).not.toHaveBeenCalled()
  })

  it('is not a step at all without the bridge: a browser, or the iPhone app', async () => {
    const connect = vi.spyOn(FakeRoom.prototype, 'connect')
    const manager = new VoiceManager(() => {})
    await manager.join('chan-1', 'token', 'ws://box')
    expect(connect).toHaveBeenCalledOnce()
  })
})

describe('the Silent switch on an iPhone', () => {
  // WebKit mutes audio that is only Web Audio when the switch is on silent,
  // and on iOS all remote voice is Web Audio. Crew with a microphone got away
  // with it because their live capture made the phone a call; crew without
  // one heard nothing. The join names the call itself (voice-playback.ts).

  const IPHONE =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
  const MAC_SAFARI =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'

  let session: { type: string }

  beforeEach(() => {
    FakeRoom.connectBehaviour = 'ok'
    FakeRoom.playbackBehaviour = 'allowed'
    session = { type: 'auto' }
    Object.defineProperty(navigator, 'audioSession', { value: session, configurable: true })
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    Reflect.deleteProperty(navigator, 'audioSession')
  })

  it('is a call before the room opens any audio', async () => {
    // WebKit applies the type when audio next starts, so it has to be in
    // place before the room connects.
    const seen: string[] = []
    const connect = FakeRoom.prototype.connect
    vi.spyOn(FakeRoom.prototype, 'connect').mockImplementation(function (this: FakeRoom) {
      seen.push(session.type)
      return connect.call(this)
    })
    const manager = new VoiceManager(() => {})

    await manager.join('chan-1', 'token', 'ws://box')

    expect(seen).toEqual(['play-and-record'])
  })

  it('stays a call for crew listening without a microphone', async () => {
    // The crew this is for: with no capture, nothing else keeps the phone
    // out of the session the switch mutes.
    const connect = FakeRoom.prototype.connect
    vi.spyOn(FakeRoom.prototype, 'connect').mockImplementation(function (this: FakeRoom) {
      this.localParticipant.setMicrophoneEnabled = vi.fn(() =>
        Promise.reject(new Error('NotAllowedError'))
      )
      return connect.call(this)
    })
    const states: Array<Record<string, unknown>> = []
    const manager = new VoiceManager((partial) => states.push({ ...partial }))

    await manager.join('chan-1', 'token', 'ws://box')
    await vi.waitFor(() =>
      expect(states).toContainEqual({ micReady: false, error: expect.any(String) })
    )

    expect(session.type).toBe('play-and-record')
  })

  it('stays a call across a change of channel', async () => {
    const manager = new VoiceManager(() => {})
    await manager.join('chan-1', 'token', 'ws://box')
    await manager.join('chan-2', 'token', 'ws://box')
    expect(session.type).toBe('play-and-record')
  })

  it('goes back to WebKit on leaving', async () => {
    // Out of voice, an alert chirp is only an alert again, and the switch
    // silences it like any other.
    const manager = new VoiceManager(() => {})
    await manager.join('chan-1', 'token', 'ws://box')
    await manager.leave()
    expect(session.type).toBe('auto')
  })

  it('goes back when the room drops', async () => {
    const manager = new VoiceManager(() => {})
    await manager.join('chan-1', 'token', 'ws://box')
    ;(manager as unknown as { room: FakeRoom }).room.emit('disconnected')
    expect(session.type).toBe('auto')
  })

  it('goes back when the join fails', async () => {
    FakeRoom.connectBehaviour = 'fail'
    const manager = new VoiceManager(() => {})
    await manager.join('chan-1', 'token', 'ws://nowhere').catch(() => {})
    expect(session.type).toBe('auto')
  })

  it('is left to WebKit off iOS', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(MAC_SAFARI)
    const connect = FakeRoom.prototype.connect
    const seen: string[] = []
    vi.spyOn(FakeRoom.prototype, 'connect').mockImplementation(function (this: FakeRoom) {
      seen.push(session.type)
      return connect.call(this)
    })
    const manager = new VoiceManager(() => {})

    await manager.join('chan-1', 'token', 'ws://box')

    expect(seen).toEqual(['auto'])
    expect(session.type).toBe('auto')
  })
})
