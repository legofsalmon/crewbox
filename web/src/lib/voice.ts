import {
  ConnectionQuality,
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  type LocalTrackPublication,
  type RemoteTrack,
} from 'livekit-client'
import {
  canSelectOutput,
  deviceLabel,
  resolveDevice,
  saveDeviceId,
  savedDeviceId,
  type AudioKind,
  type DeviceInfo,
} from './devices.ts'

export type VoiceQuality = 'excellent' | 'good' | 'poor' | 'lost' | 'unknown'

export interface VoiceParticipant {
  id: string
  name: string
  speaking: boolean
  quality: VoiceQuality
}

export interface VoiceState {
  channelId: string | null
  status: 'idle' | 'joining' | 'connected' | 'reconnecting'
  participants: VoiceParticipant[]
  talking: boolean
  /** Latch mode keeps the mic open without holding the button (gloves!). */
  latched: boolean
  /** False until the mic is captured; denied mics leave you listen-only. */
  micReady: boolean
  /** My own network quality as LiveKit sees it. */
  myQuality: VoiceQuality
  /** 0–1 live level of my mic (only while captured); null when unavailable. */
  micLevel: number | null
  devices: { inputs: DeviceInfo[]; outputs: DeviceInfo[]; canSelectOutput: boolean }
  selectedInput: string | null
  selectedOutput: string | null
  error: string | null
}

export const initialVoiceState: VoiceState = {
  channelId: null,
  status: 'idle',
  participants: [],
  talking: false,
  latched: false,
  micReady: false,
  myQuality: 'unknown',
  micLevel: null,
  devices: { inputs: [], outputs: [], canSelectOutput: canSelectOutput() },
  selectedInput: null,
  selectedOutput: null,
  error: null,
}

const CONNECT_TIMEOUT_MS = 10_000
const LEVEL_INTERVAL_MS = 100

type Publish = (state: Partial<VoiceState>) => void

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

  constructor(private readonly publish: Publish) {
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
        if (pub.kind === Track.Kind.Audio) this.startLevelMeter()
      })
      .on(RoomEvent.Reconnecting, () => this.publish({ status: 'reconnecting' }))
      .on(RoomEvent.Reconnected, () => this.publish({ status: 'connected' }))
      .on(RoomEvent.Disconnected, () => {
        if (this.room === room) this.reset()
      })

    try {
      await Promise.race([
        room.connect(url, token),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('voice server not reachable')), CONNECT_TIMEOUT_MS),
        ),
      ])
      await room.startAudio()
      // Listening works from here even if the mic never materialises.
      this.publish({
        status: 'connected',
        talking: false,
        latched: false,
        selectedInput: savedIn,
        selectedOutput: savedOut,
      })
      this.publishParticipants()
      void this.refreshDevices()
      void this.acquireMic()
    } catch (err) {
      this.reset(err instanceof Error ? err.message : 'could not join voice')
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
        new Promise((_, reject) => setTimeout(() => reject(new Error('mic timeout')), CONNECT_TIMEOUT_MS)),
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

  /** Open/close the mic. Mute-based, so open latency is near-zero. */
  async setTalking(on: boolean): Promise<void> {
    if (!this.room || this.room.state !== ConnectionState.Connected) return
    this.publish({ talking: on })
    try {
      await this.room.localParticipant.setMicrophoneEnabled(on)
      if (on) this.publish({ micReady: true })
    } catch {
      this.publish({ talking: false, error: 'Microphone unavailable — listen-only' })
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
              : { selectedOutput: null, error: 'Speaker disconnected — using default' },
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
      // otherwise the send-track.
      if (kind === 'audioinput') {
        if (this.micTestStream) void this.startMicTest()
        else this.startLevelMeter()
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
      this.levelTimer = window.setInterval(() => {
        analyser.getByteTimeDomainData(data)
        let peak = 0
        for (const v of data) peak = Math.max(peak, Math.abs(v - 128) / 128)
        this.publish({ micLevel: peak })
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
    this.stopMicTest()
    for (const el of this.audioEls) el.remove()
    this.audioEls.clear()
    this.room = null
    this.channelId = null
    this.publish({ ...initialVoiceState, devices: initialVoiceState.devices, error })
  }
}
