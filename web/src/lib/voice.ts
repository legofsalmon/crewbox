import {
  ConnectionQuality,
  Room,
  RoomEvent,
  Track,
  type LocalTrackPublication,
  type RemoteTrack,
} from 'livekit-client'
import {
  canSelectOutput,
  deviceLabel,
  isIOS,
  resolveDevice,
  saveDeviceId,
  savedDeviceId,
  type AudioKind,
  type DeviceInfo,
} from './devices.ts'
import { isSafari, shouldMixThroughWebAudio } from './voice-playback.ts'

import {
  initialVoiceState,
  type VoiceParticipant,
  type VoiceQuality,
  type VoiceState,
} from './voice-state.ts'

export type { VoiceParticipant, VoiceQuality, VoiceState }

const CONNECT_TIMEOUT_MS = 10_000
const LEVEL_INTERVAL_MS = 100

type Publish = (state: Partial<VoiceState>) => void

/**
 * Something the crew has to be told, rather than a state the UI can render.
 *
 * Needed because the two moments that matter most here — a join that failed
 * and a room that dropped — both end with the voice bar unmounted, so there
 * is no longer any surface left to put the reason on.
 */
type Notify = (message: string) => void

function toQuality(q: ConnectionQuality): VoiceQuality {
  switch (q) {
    case ConnectionQuality.Excellent:
      return 'excellent'
    case ConnectionQuality.Good:
      return 'good'
    case ConnectionQuality.Poor:
      return 'poor'
    case ConnectionQuality.Lost:
      return 'lost'
    default:
      return 'unknown'
  }
}

/**
 * Owns the LiveKit room across channel switches — an intercom stays live
 * while you read other channels. UI state flows out through `publish`.
 */
export class VoiceManager {
  private room: Room | null = null
  private channelId: string | null = null
  private audioEls = new Set<HTMLAudioElement>()
  private levelTimer: number | null = null
  private analyser: AnalyserNode | null = null
  private analyserCtx: AudioContext | null = null
  private micTestStream: MediaStream | null = null
  private talking = false

  constructor(
    private readonly publish: Publish,
    private readonly notify: Notify = () => {}
  ) {
    navigator.mediaDevices?.addEventListener?.('devicechange', () => {
      void this.refreshDevices()
    })
  }

  async join(channelId: string, token: string, url: string): Promise<void> {
    await this.leave()
    this.channelId = channelId
    this.publish({ channelId, status: 'joining', error: null, participants: [] })

    const savedIn = savedDeviceId('audioinput')
    const savedOut = savedDeviceId('audiooutput')
    const room = new Room({
      // Tuned for intercom: tiny buffers beat pristine audio.
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: true,
        ...(savedIn ? { deviceId: savedIn } : {}),
      },
      ...(savedOut && canSelectOutput() ? { audioOutput: { deviceId: savedOut } } : {}),
      publishDefaults: { dtx: true, red: true, stopMicTrackOnMute: false },
      // One mixed audio graph instead of an element per speaker, on the
      // browsers that need it. See voice-playback.ts for why it is not
      // simply on everywhere.
      webAudioMix: shouldMixThroughWebAudio({ ios: isIOS(), safari: isSafari() }),
    })
    this.room = room

    room
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (track.kind === Track.Kind.Audio) {
          const el = track.attach()
          this.audioEls.add(el)
          document.body.appendChild(el)
        }
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        for (const el of track.detach()) {
          this.audioEls.delete(el as HTMLAudioElement)
          el.remove()
        }
      })
      .on(RoomEvent.ParticipantConnected, () => this.publishParticipants())
      .on(RoomEvent.ParticipantDisconnected, () => this.publishParticipants())
      .on(RoomEvent.ActiveSpeakersChanged, () => this.publishParticipants())
      .on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
        if (participant.identity === room.localParticipant.identity) {
          this.publish({ myQuality: toQuality(quality) })
        }
        this.publishParticipants()
      })
      .on(RoomEvent.LocalTrackPublished, (pub: LocalTrackPublication) => {
        // Covers the first-ever talk press, where the track publishes after
        // setTalking already tried (and failed) to find one to meter.
        if (pub.kind === Track.Kind.Audio && this.talking && !this.micTestStream) {
          this.startLevelMeter()
        }
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => {
        // Truthful either way: it goes up when the browser blocks playback
        // and down again the moment a gesture unblocks it, including when
        // that gesture was somewhere else entirely.
        this.publish({ audioBlocked: !room.canPlaybackAudio })
      })
      .on(RoomEvent.Reconnecting, () => this.publish({ status: 'reconnecting' }))
      .on(RoomEvent.Reconnected, () => {
        this.publish({ status: 'connected' })
        // Reconcile the mic to the intent captured during the outage. If a
        // release was dropped while reconnecting, this is what finally closes
        // the mic; if a press was, it opens it. Without this the mic state
        // after a reconnect is whatever LiveKit last published, not what the
        // crew member is actually asking for.
        void this.applyMic()
      })
      .on(RoomEvent.Disconnected, () => {
        // Only an *unexpected* drop reaches this: `leave()` nulls `this.room`
        // before disconnecting, so a deliberate exit fails this guard and
        // stays silent.
        if (this.room === room) {
          this.reset()
          // Being dropped off comms without being told is worse than a failed
          // join. A failed join is at least visibly nothing happening — this
          // leaves someone believing they are on the intercom, talking to a
          // channel that stopped hearing them, which on a show is how a call
          // for help goes unanswered.
          this.notify('Voice dropped — you are no longer on the intercom')
        }
      })

    try {
      await Promise.race([
        room.connect(url, token),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('voice server not reachable')), CONNECT_TIMEOUT_MS)
        ),
      ])
      // Deliberately not awaited into the join's failure path. Blocked
      // autoplay is the *normal* first join on iOS, and treating it as a
      // failed join was worse than useless: the crew member was told the
      // join failed while the room stayed connected underneath — present in
      // the SFU, absent from the UI, hearing nothing and unaware they could
      // still be heard. It is now a state with a button on it.
      void room.startAudio().catch(() => {})
      // Listening works from here even if the mic never materialises.
      this.publish({
        status: 'connected',
        talking: false,
        latched: false,
        audioBlocked: !room.canPlaybackAudio,
        selectedInput: savedIn,
        selectedOutput: savedOut,
      })
      this.publishParticipants()
      void this.refreshDevices()
      void this.acquireMic()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'could not join voice'
      this.reset(message)
      // Rethrow, or nobody ever finds out.
      //
      // `reset()` files the reason in `voice.error` and nulls `channelId`,
      // which unmounts the voice bar — so the entire visible result of a
      // failed join was a banner appearing for one frame and vanishing, with
      // the reason readable only in the audio settings panel you would have
      // had to already have open. The store's `joinVoice` has the toast, and
      // swallowing here meant its catch block only ever fired for a failed
      // *token* request, never for a failed connection — which is the far
      // likelier failure and the one that was actually reported.
      //
      // Reproduced before fixing: box pointed at an unreachable SFU, join
      // clicked, bar flashed, no toast, real reason in the browser console
      // where no crew member will ever look.
      throw err instanceof Error ? err : new Error(message)
    }
  }

  /**
   * Capture the mic once (muted) so later push-to-talk is an instant
   * unmute. A denied/blocked mic degrades to listen-only instead of
   * failing the whole join.
   */
  private async acquireMic(): Promise<void> {
    const room = this.room
    if (!room) return
    try {
      await Promise.race([
        (async () => {
          await room.localParticipant.setMicrophoneEnabled(true)
          await room.localParticipant.setMicrophoneEnabled(false)
        })(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('mic timeout')), CONNECT_TIMEOUT_MS)
        ),
      ])
      if (this.room === room) {
        this.publish({ micReady: true })
        // Device labels are only revealed after a successful capture.
        void this.refreshDevices()
      }
    } catch {
      if (this.room === room) {
        this.publish({ micReady: false, error: 'Microphone unavailable — listen-only' })
      }
    }
  }

  async leave(): Promise<void> {
    const room = this.room
    this.room = null
    this.channelId = null
    if (room) await room.disconnect()
    this.reset()
  }

  /**
   * Let the audio through, from a real user gesture.
   *
   * The only cure for a browser that has decided this page may not make a
   * noise, and it has to be called from a tap — which is why it is a method
   * the UI can bind to a button rather than something retried on a timer.
   */
  async resumeAudio(): Promise<void> {
    const room = this.room
    if (!room) return
    try {
      await room.startAudio()
      this.publish({ audioBlocked: !room.canPlaybackAudio })
    } catch {
      this.publish({ audioBlocked: true })
    }
  }

  /** Open/close the mic. Mute-based, so open latency is near-zero. */
  async setTalking(on: boolean): Promise<void> {
    if (!this.room) return
    // Record the *intent* first, unconditionally. The old code returned early
    // when the room was not Connected — but a release (on=false) arriving
    // while the room is Reconnecting would then be dropped, and LiveKit
    // re-publishes the last enabled track on reconnection: a hot mic the crew
    // member believes they closed. Intent is recorded here and reconciled to
    // the real mic in `applyMic`, which also runs again on Reconnected.
    this.talking = on
    this.publish({ talking: on })
    // Meter the send track while transmitting so the UI can show the mic is
    // hearing you (muted tracks read as silence, so only meter while open).
    // The settings-panel test capture, when active, already feeds the meter.
    if (!this.micTestStream) {
      if (on) this.startLevelMeter()
      else {
        this.stopLevelMeter()
        this.publish({ micLevel: null })
      }
    }
    await this.applyMic()
  }

  /**
   * Push the desired talking state onto the actual microphone.
   *
   * Called on every press and release, and again from the Reconnected
   * handler, so the mic can never lag the intent. A failed *open* falls back
   * to listen-only; a failed *close* keeps the intent false so the next
   * reconnect retries it rather than leaving the mic hot.
   */
  private async applyMic(): Promise<void> {
    const room = this.room
    if (!room) return
    const wanted = this.talking
    try {
      await room.localParticipant.setMicrophoneEnabled(wanted)
      if (wanted && this.room === room) this.publish({ micReady: true })
    } catch {
      if (wanted && this.room === room) {
        this.talking = false
        this.publish({ talking: false, error: 'Microphone unavailable — listen-only' })
      }
      // A failed close leaves this.talking === false, so the Reconnected
      // reconcile will try again; the mic is never silently left open.
    }
  }

  // -- devices ---------------------------------------------------------------

  async refreshDevices(): Promise<void> {
    if (!navigator.mediaDevices?.enumerateDevices) return
    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      const pick = (kind: AudioKind): DeviceInfo[] =>
        all
          .filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default')
          .map((d, i) => ({ deviceId: d.deviceId, label: deviceLabel(d, i) }))
      const inputs = pick('audioinput')
      const outputs = pick('audiooutput')
      this.publish({ devices: { inputs, outputs, canSelectOutput: canSelectOutput() } })

      // If the chosen device vanished (headset unplugged), fall back loudly.
      for (const kind of ['audioinput', 'audiooutput'] as const) {
        const available = kind === 'audioinput' ? inputs : outputs
        const { fellBack } = resolveDevice(savedDeviceId(kind), available)
        if (fellBack) {
          saveDeviceId(kind, null)
          this.publish(
            kind === 'audioinput'
              ? { selectedInput: null, error: 'Mic disconnected — using default' }
              : { selectedOutput: null, error: 'Speaker disconnected — using default' }
          )
          if (this.room) void this.room.switchActiveDevice(kind, 'default')
        }
      }
    } catch {
      // enumeration can fail pre-permission; the pickers just stay empty
    }
  }

  async setDevice(kind: AudioKind, deviceId: string | null): Promise<void> {
    saveDeviceId(kind, deviceId)
    this.publish(kind === 'audioinput' ? { selectedInput: deviceId } : { selectedOutput: deviceId })
    if (!this.room) return
    try {
      await this.room.switchActiveDevice(kind, deviceId ?? 'default')
      // Re-point the meter at the new mic: the live test if the panel is open,
      // otherwise the send-track (only meaningful while transmitting).
      if (kind === 'audioinput') {
        if (this.micTestStream) void this.startMicTest()
        else if (this.talking) this.startLevelMeter()
      }
    } catch {
      this.publish({ error: 'Could not switch audio device' })
    }
  }

  // -- mic level meter -------------------------------------------------------

  /**
   * Live meter for the settings panel: a dedicated capture so the bar reacts
   * to your voice without holding talk and without sending any audio. Falls
   * back to the live send-track (only audible while talking) if a separate
   * capture is denied or unavailable.
   */
  async startMicTest(): Promise<void> {
    this.stopMicTest()
    if (navigator.mediaDevices?.getUserMedia) {
      const saved = savedDeviceId('audioinput')
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: saved ? { deviceId: { exact: saved } } : true,
        })
        this.micTestStream = stream
        const track = stream.getAudioTracks()[0]
        if (track) return this.meterTrack(track)
      } catch {
        // denied/busy — fall through to the send-track meter below
      }
    }
    this.startLevelMeter()
  }

  stopMicTest(): void {
    this.stopLevelMeter()
    if (this.micTestStream) {
      for (const t of this.micTestStream.getTracks()) t.stop()
      this.micTestStream = null
    }
    this.publish({ micLevel: null })
  }

  /** Meter the live send-track — only shows level while the mic is unmuted. */
  private startLevelMeter(): void {
    const track = this.room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track
    const mediaTrack = track?.mediaStreamTrack
    if (mediaTrack) this.meterTrack(mediaTrack)
  }

  /** Feed any mic MediaStreamTrack into an analyser so the UI can show life. */
  private meterTrack(mediaTrack: MediaStreamTrack): void {
    this.stopLevelMeter()
    try {
      const ctx = new AudioContext()
      void ctx.resume().catch(() => {})
      const source = ctx.createMediaStreamSource(new MediaStream([mediaTrack]))
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      source.connect(analyser)
      this.analyserCtx = ctx
      this.analyser = analyser
      const data = new Uint8Array(analyser.frequencyBinCount)
      // VU-style smoothing: jump up instantly, decay gradually. Keeps the
      // settings meter and the talk-button halo readable without relying on
      // CSS transitions.
      let smoothed = 0
      this.levelTimer = window.setInterval(() => {
        analyser.getByteTimeDomainData(data)
        let peak = 0
        for (const v of data) peak = Math.max(peak, Math.abs(v - 128) / 128)
        smoothed = peak > smoothed ? peak : smoothed * 0.7
        this.publish({ micLevel: smoothed < 0.01 ? 0 : smoothed })
      }, LEVEL_INTERVAL_MS)
    } catch {
      this.publish({ micLevel: null })
    }
  }

  private stopLevelMeter(): void {
    if (this.levelTimer !== null) clearInterval(this.levelTimer)
    this.levelTimer = null
    this.analyser = null
    void this.analyserCtx?.close().catch(() => {})
    this.analyserCtx = null
  }

  private publishParticipants(): void {
    const room = this.room
    if (!room) return
    const speakingIds = new Set(room.activeSpeakers.map((p) => p.identity))
    const list: VoiceParticipant[] = [
      {
        id: room.localParticipant.identity,
        name: room.localParticipant.name || 'me',
        speaking: speakingIds.has(room.localParticipant.identity),
        quality: toQuality(room.localParticipant.connectionQuality),
      },
      ...[...room.remoteParticipants.values()].map((p) => ({
        id: p.identity,
        name: p.name || p.identity,
        speaking: speakingIds.has(p.identity),
        quality: toQuality(p.connectionQuality),
      })),
    ]
    this.publish({ participants: list })
  }

  private reset(error: string | null = null): void {
    this.talking = false
    this.stopMicTest()
    for (const el of this.audioEls) el.remove()
    this.audioEls.clear()
    // Hang up on the way out. `reset` used to only drop the reference, so a
    // join that failed after `connect` had already succeeded left a live
    // room with nothing pointing at it: the crew member vanished from their
    // own UI while staying in the SFU's participant list, and the next join
    // arrived as a second device belonging to the same person.
    const room = this.room
    this.room = null
    this.channelId = null
    if (room) void room.disconnect().catch(() => {})
    this.publish({ ...initialVoiceState, devices: initialVoiceState.devices, error })
  }
}
