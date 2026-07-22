import {
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
} from 'livekit-client'

export interface VoiceParticipant {
  id: string
  name: string
  speaking: boolean
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
  error: string | null
}

export const initialVoiceState: VoiceState = {
  channelId: null,
  status: 'idle',
  participants: [],
  talking: false,
  latched: false,
  micReady: false,
  error: null,
}

const CONNECT_TIMEOUT_MS = 10_000

type Publish = (state: Partial<VoiceState>) => void

/**
 * Owns the LiveKit room across channel switches — an intercom stays live
 * while you read other channels. UI state flows out through `publish`.
 */
export class VoiceManager {
  private room: Room | null = null
  private channelId: string | null = null
  private audioEls = new Set<HTMLAudioElement>()

  constructor(private readonly publish: Publish) {}

  async join(channelId: string, token: string, url: string): Promise<void> {
    await this.leave()
    this.channelId = channelId
    this.publish({ channelId, status: 'joining', error: null, participants: [] })

    const room = new Room({
      // Tuned for intercom: tiny buffers beat pristine audio.
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true },
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
      this.publish({ status: 'connected', talking: false, latched: false })
      this.publishParticipants()
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
      if (this.room === room) this.publish({ micReady: true })
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

  private publishParticipants(): void {
    const room = this.room
    if (!room) return
    const speakingIds = new Set(room.activeSpeakers.map((p) => p.identity))
    const list: VoiceParticipant[] = [
      {
        id: room.localParticipant.identity,
        name: room.localParticipant.name || 'me',
        speaking: speakingIds.has(room.localParticipant.identity),
      },
      ...[...room.remoteParticipants.values()].map((p) => ({
        id: p.identity,
        name: p.name || p.identity,
        speaking: speakingIds.has(p.identity),
      })),
    ]
    this.publish({ participants: list })
  }

  private reset(error: string | null = null): void {
    for (const el of this.audioEls) el.remove()
    this.audioEls.clear()
    this.room = null
    this.channelId = null
    this.publish({ ...initialVoiceState, error })
  }
}
