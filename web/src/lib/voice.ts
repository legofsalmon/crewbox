import {
  ConnectionQuality,
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  type LocalTrackPublication,
  type RemoteAudioTrack,
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
import { nativeVoice } from './server.ts'
import {
  holdCallAudio,
  isSafari,
  releaseCallAudio,
  shouldMixThroughWebAudio,
} from './voice-playback.ts'
import { qosBetween, worstQos, type ReceiverSample, type VoiceQos } from './voice-qos.ts'

import {
  initialVoiceState,
  MAX_LISTEN,
  type VoiceListen,
  type VoiceParticipant,
  type VoiceQuality,
  type VoiceState,
} from './voice-state.ts'

export type { VoiceListen, VoiceParticipant, VoiceQuality, VoiceState }

const CONNECT_TIMEOUT_MS = 10_000
const LEVEL_INTERVAL_MS = 100

/**
 * How often to ask the decoder how comms sounded.
 *
 * Slow on purpose. Each pass walks every subscribed track's stats, the
 * numbers only mean anything over a window, and this runs on a phone in
 * someone's pocket for a twelve-hour day.
 */
const QOS_INTERVAL_MS = 15_000

type Publish = (state: Partial<VoiceState>) => void

/** Where a quality reading goes. The store hands this to the WebSocket. */
export type ReportQos = (qos: VoiceQos) => void

/**
 * Something the crew has to be told, rather than a state the UI can render.
 *
 * Needed because the two moments that matter most here — a join that failed
 * and a room that dropped — both end with the voice bar unmounted, so there
 * is no longer any surface left to put the reason on.
 */
type Notify = (message: string) => void

/** A channel's name as the crew read it ("#foh", "Sam"), for a notice. */
type NameOf = (channelId: string) => string

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
 * One audio receiver's raw inbound-rtp counters.
 *
 * `getReceiverStats()` is the SDK's own trimmed object, and it does not
 * carry `packetsLost` or `packetsReceived` — so the loss figure computed
 * from it was always exactly zero, on every reading, for every crew member,
 * and the voice-quality line said "clean" through a show that was breaking
 * up. The browser's own report has the counters; this reads that and keeps
 * the SDK's object as the fallback for anything that will not answer.
 */
async function inboundAudioSample(track: RemoteAudioTrack): Promise<ReceiverSample | undefined> {
  const receiver = (track as { receiver?: RTCRtpReceiver }).receiver
  if (typeof receiver?.getStats === 'function') {
    try {
      const report = await receiver.getStats()
      for (const entry of report.values()) {
        const stat = entry as RTCStats & Record<string, number | string | undefined>
        if (stat.type !== 'inbound-rtp' || stat.kind !== 'audio') continue
        return {
          timestamp: Number(stat.timestamp),
          ...(typeof stat.packetsLost === 'number' ? { packetsLost: stat.packetsLost } : {}),
          ...(typeof stat.packetsReceived === 'number'
            ? { packetsReceived: stat.packetsReceived }
            : {}),
          ...(typeof stat.concealedSamples === 'number'
            ? { concealedSamples: stat.concealedSamples }
            : {}),
          ...(typeof stat.totalSamplesDuration === 'number'
            ? { totalSamplesDuration: stat.totalSamplesDuration }
            : {}),
          ...(typeof stat.jitter === 'number' ? { jitter: stat.jitter } : {}),
        }
      }
    } catch {
      // Fall through to the SDK's own object.
    }
  }
  if (typeof track.getReceiverStats !== 'function') return undefined
  try {
    return (await track.getReceiverStats()) as ReceiverSample | undefined
  } catch {
    return undefined
  }
}

/** A channel being heard but not talked on. See `VoiceManager.listen`. */
interface ListenRoom {
  room: Room
  status: VoiceListen['status']
}

/**
 * Owns the LiveKit rooms across channel switches — an intercom stays live
 * while you read other channels. UI state flows out through `publish`.
 *
 * Party line: one room is the talk channel (`room`), where the microphone is
 * published and push-to-talk opens it; up to `MAX_LISTEN` more are channels
 * being heard (`listens`), each its own room with nothing published. One room
 * per channel, as before, so a channel's membership is still what the box's
 * token says it is: a private channel or a DM is never audible to somebody
 * who is not in it, which a single box-wide room with a track per channel
 * could not promise. The cost is a connection per channel heard, which is
 * why there is a cap.
 *
 * Talk and listen are roles a room has, not kinds of room. Talking on a
 * channel already being heard moves its room into the talk slot rather than
 * connecting again, so there is no gap in hearing it and nobody on it sees
 * you leave and come back.
 */
export class VoiceManager {
  private room: Room | null = null
  private channelId: string | null = null
  private listens = new Map<string, ListenRoom>()
  /** Rooms whose `connect()` resolved — see the Disconnected handler. */
  private connected = new WeakSet<Room>()
  private audioEls = new Map<Room, Set<HTMLAudioElement>>()
  /**
   * The one Web Audio graph every room mixes through, where mixing is on.
   *
   * Shared rather than one per room: iOS caps how many contexts a page may
   * hold, each starts suspended, and each would need its own tap to unlock.
   * One context means "Tap to hear comms" unlocks every channel at once.
   * LiveKit leaves a context it was handed open when its room disconnects,
   * so `reset` closes it.
   */
  private mixCtx: AudioContext | null = null
  private levelTimer: number | null = null
  private analyser: AnalyserNode | null = null
  private analyserCtx: AudioContext | null = null
  private micTestStream: MediaStream | null = null
  private talking = false
  private qosTimer: number | null = null
  /** Last stats per track sid, so each pass reads a window and not a lifetime. */
  private qosPrevious = new Map<string, ReceiverSample>()

  constructor(
    private readonly publish: Publish,
    private readonly notify: Notify = () => {},
    private readonly reportQos: ReportQos = () => {},
    private readonly nameOf: NameOf = (channelId) => channelId
  ) {
    navigator.mediaDevices?.addEventListener?.('devicechange', () => {
      void this.refreshDevices()
    })
  }

  /**
   * `iceServers` is the box's list, when it sent one, and replaces the SFU's.
   * Empty means ask no STUN server at all, which is what a box sends for its
   * own SFU (see /api/voice/token). Absent, the SFU's list stands.
   *
   * Moves the talk channel here. Channels being heard stay heard, and a
   * channel that was one of them is promoted rather than joined again; the
   * channel talked on before is left, as it always was. `talkOn` is the swap
   * that keeps hearing it.
   */
  async join(
    channelId: string,
    token: string,
    url: string,
    iceServers?: RTCIceServer[]
  ): Promise<void> {
    if (this.promote(channelId, { keepOld: false })) return
    // Still connecting as a channel heard: give that up first. The same
    // person in the same room twice is one too many, and LiveKit settles it
    // by throwing the older one out.
    this.stopListening(channelId)
    await this.dropTalkRoom()
    this.channelId = channelId
    this.publish({
      channelId,
      status: 'joining',
      error: null,
      participants: [],
      talking: false,
      latched: false,
      micReady: false,
    })
    // Before anything below opens audio. The Android web view reads the
    // Bluetooth permission once, when its audio first starts, so this is the
    // moment asking about a headset can still count (VoicePlugin.java). A
    // bridge that fails is a headset that doesn't follow, never a failed join.
    await nativeVoice()
      ?.prepare()
      .catch(() => {})
    // Left, or joined somewhere else, while Android was asking.
    if (this.channelId !== channelId) return
    // The iPhone's side, and also before any audio: WebKit applies the
    // session type when audio next starts. `reset` hands it back.
    holdCallAudio({ ios: isIOS() })

    const savedIn = savedDeviceId('audioinput')
    const savedOut = savedDeviceId('audiooutput')
    const room = this.newRoom()
    this.room = room

    try {
      await this.connect(room, url, token, iceServers)
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
        audioBlocked: this.playbackBlocked(),
        selectedInput: savedIn,
        selectedOutput: savedOut,
      })
      this.publishParticipants()
      void this.refreshDevices()
      void this.acquireMic()
      this.startQosSampling()
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
   * Hear another channel as well as the one you talk on.
   *
   * Only while on voice: a channel heard rides on the talk channel's call
   * (the iPhone's audio session, the Android headset bridge, the voice bar
   * that shows it), so leaving voice leaves every channel. Nothing is ever
   * published here; the microphone only exists in the talk room.
   *
   * Throws with a sentence for the crew when it cannot, like `join`.
   */
  async listen(
    channelId: string,
    token: string,
    url: string,
    iceServers?: RTCIceServer[]
  ): Promise<void> {
    if (!this.room) throw new Error('join voice first')
    if (channelId === this.channelId || this.listens.has(channelId)) return
    if (this.listens.size >= MAX_LISTEN) {
      throw new Error(`you can hear ${MAX_LISTEN} other channels at most`)
    }
    const room = this.newRoom()
    const entry: ListenRoom = { room, status: 'joining' }
    this.listens.set(channelId, entry)
    this.publishListening()
    try {
      await this.connect(room, url, token, iceServers)
    } catch (err) {
      if (this.listens.get(channelId) === entry) this.listens.delete(channelId)
      this.dropRoom(room)
      this.publishListening()
      throw err instanceof Error ? err : new Error('could not reach that channel')
    }
    // Stopped, or left voice altogether, while it was connecting.
    if (this.listens.get(channelId) !== entry) {
      this.dropRoom(room)
      return
    }
    entry.status = 'connected'
    void room
      .startAudio()
      .catch(() => {})
      .finally(() => this.publish({ audioBlocked: this.playbackBlocked() }))
    this.publishListening()
  }

  /** Stop hearing a channel. Quietly: it was asked for. */
  stopListening(channelId: string): void {
    const entry = this.listens.get(channelId)
    if (!entry) return
    this.listens.delete(channelId)
    this.dropRoom(entry.room)
    this.publishListening()
    this.publish({ audioBlocked: this.playbackBlocked() })
  }

  /**
   * Talk on a channel being heard, and keep hearing the one talked on
   * before: the party-line swap. False when it is not one being heard (or is
   * still connecting), so the caller can fall back to a join.
   */
  talkOn(channelId: string): boolean {
    return this.promote(channelId, { keepOld: true })
  }

  /**
   * Move a heard channel's room into the talk slot.
   *
   * The mic closes first, latch and all, and the talk target only changes
   * once it has: a target that moves under an open mic is how a word meant
   * for one channel lands on another, mid-sentence, with the speaker none the
   * wiser. The new room is the talk room before the old one gives up its
   * mic, so a press that lands during the swap opens the mic where the
   * button now says it will, never back where it was.
   */
  private promote(channelId: string, { keepOld }: { keepOld: boolean }): boolean {
    const entry = this.listens.get(channelId)
    if (!entry || entry.status === 'joining' || !this.room || !this.channelId) return false
    // Not mid-join either: the join still has its own room to finish setting
    // up, and would do it over the top of this one.
    if (!this.connected.has(this.room)) return false
    const old = this.room
    const oldChannelId = this.channelId

    this.talking = false
    if (!this.micTestStream) this.stopLevelMeter()
    this.listens.delete(channelId)
    this.room = entry.room
    this.channelId = channelId
    this.publish({
      channelId,
      status: entry.status,
      talking: false,
      latched: false,
      micReady: false,
      ...(this.micTestStream ? {} : { micLevel: null }),
      myQuality: toQuality(entry.room.localParticipant.connectionQuality),
    })

    if (keepOld) {
      this.listens.set(oldChannelId, {
        room: old,
        status: old.state === ConnectionState.Reconnecting ? 'reconnecting' : 'connected',
      })
    }
    void this.unpublishMic(old).finally(() => {
      if (!keepOld) this.dropRoom(old)
    })
    this.publishParticipants()
    this.publishListening()
    void this.acquireMic()
    return true
  }

  /** Close a room that is leaving the talk slot. Its mic goes with it. */
  private async unpublishMic(room: Room): Promise<void> {
    const track = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track
    if (!track) return
    try {
      await room.localParticipant.unpublishTrack(track, true)
    } catch {
      // A room on its way out may refuse; muted is still muted, and a
      // dropped room takes the track with it.
      await room.localParticipant.setMicrophoneEnabled(false).catch(() => {})
    }
  }

  /** Hang up the talk channel only, keeping the channels being heard. */
  private async dropTalkRoom(): Promise<void> {
    const room = this.room
    this.room = null
    this.channelId = null
    this.talking = false
    if (!this.micTestStream) this.stopLevelMeter()
    this.stopQosSampling()
    if (room) {
      this.removeAudio(room)
      await room.disconnect().catch(() => {})
    }
  }

  private newRoom(): Room {
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
      webAudioMix: this.mixSetting(),
    })
    this.wire(room)
    return room
  }

  private mixSetting(): boolean | { audioContext: AudioContext } {
    if (!shouldMixThroughWebAudio({ ios: isIOS(), safari: isSafari() })) return false
    if (!this.mixCtx || this.mixCtx.state === 'closed') {
      try {
        this.mixCtx = new AudioContext({ latencyHint: 'interactive' })
      } catch {
        // No Web Audio to share: LiveKit makes its own, as it always did.
        return true
      }
    }
    return { audioContext: this.mixCtx }
  }

  private async connect(
    room: Room,
    url: string,
    token: string,
    iceServers?: RTCIceServer[]
  ): Promise<void> {
    await Promise.race([
      // An empty list has to reach the SDK as a list: it applies the SFU's
      // servers whenever `rtcConfig.iceServers` is missing, and an empty
      // array is not missing (makeRTCConfiguration, in livekit-client).
      room.connect(url, token, iceServers ? { rtcConfig: { iceServers } } : undefined),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('voice server not reachable')), CONNECT_TIMEOUT_MS)
      ),
    ])
    this.connected.add(room)
  }

  /** The channel a room is heard on, when it is one being heard. */
  private listenIdOf(room: Room): string | undefined {
    for (const [id, entry] of this.listens) if (entry.room === room) return id
    return undefined
  }

  private playbackBlocked(): boolean {
    const rooms = [this.room, ...[...this.listens.values()].map((l) => l.room)]
    return rooms.some((r) => r !== null && this.connected.has(r) && !r.canPlaybackAudio)
  }

  private removeAudio(room: Room): void {
    for (const el of this.audioEls.get(room) ?? []) el.remove()
    this.audioEls.delete(room)
  }

  /** Hang up a room nothing should be holding any more. */
  private dropRoom(room: Room): void {
    this.removeAudio(room)
    void room.disconnect().catch(() => {})
  }

  /**
   * One set of handlers for every room, asking on each event which role the
   * room has now, because a room can change role (see `promote`).
   */
  private wire(room: Room): void {
    room
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (track.kind === Track.Kind.Audio) {
          const el = track.attach()
          const els = this.audioEls.get(room) ?? new Set<HTMLAudioElement>()
          els.add(el)
          this.audioEls.set(room, els)
          document.body.appendChild(el)
        }
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        for (const el of track.detach()) {
          this.audioEls.get(room)?.delete(el as HTMLAudioElement)
          el.remove()
        }
      })
      .on(RoomEvent.ParticipantConnected, () => this.refresh(room))
      .on(RoomEvent.ParticipantDisconnected, () => this.refresh(room))
      .on(RoomEvent.ActiveSpeakersChanged, () => this.refresh(room))
      .on(RoomEvent.TrackPublished, () => this.refresh(room))
      .on(RoomEvent.TrackUnpublished, () => this.refresh(room))
      .on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
        if (this.room === room && participant.identity === room.localParticipant.identity) {
          this.publish({ myQuality: toQuality(quality) })
        }
        this.refresh(room)
      })
      .on(RoomEvent.LocalTrackPublished, (pub: LocalTrackPublication) => {
        // Covers the first-ever talk press, where the track publishes after
        // setTalking already tried (and failed) to find one to meter.
        if (
          this.room === room &&
          pub.kind === Track.Kind.Audio &&
          this.talking &&
          !this.micTestStream
        ) {
          this.startLevelMeter()
        }
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => {
        // Truthful either way: it goes up when the browser blocks playback
        // and down again the moment a gesture unblocks it, including when
        // that gesture was somewhere else entirely.
        this.publish({ audioBlocked: this.playbackBlocked() })
      })
      .on(RoomEvent.Reconnecting, () => {
        if (this.room === room) this.publish({ status: 'reconnecting' })
        else this.setListenStatus(room, 'reconnecting')
      })
      .on(RoomEvent.Reconnected, () => {
        if (this.room !== room) {
          this.setListenStatus(room, 'connected')
          return
        }
        this.publish({ status: 'connected' })
        // Reconcile the mic to the intent captured during the outage. If a
        // release was dropped while reconnecting, this is what finally closes
        // the mic; if a press was, it opens it. Without this the mic state
        // after a reconnect is whatever LiveKit last published, not what the
        // crew member is actually asking for.
        void this.applyMic()
      })
      .on(RoomEvent.Disconnected, () => {
        // Only an *unexpected* drop reaches either branch: `leave()` nulls
        // `this.room` and empties `listens` before disconnecting, and every
        // other hang-up takes the room out of both first, so a deliberate
        // exit fails these guards and stays silent.
        //
        // `connected` is the other half. A *failed* connect also fires this,
        // with `this.room` still set — so every join against an unreachable
        // SFU told the crew member they had been dropped off the intercom
        // they had never been on, on top of the join error they were
        // already being shown. Two toasts, one of them false.
        if (!this.connected.has(room)) return
        if (this.room === room) {
          this.reset()
          // Being dropped off comms without being told is worse than a failed
          // join. A failed join is at least visibly nothing happening — this
          // leaves someone believing they are on the intercom, talking to a
          // channel that stopped hearing them, which on a show is how a call
          // for help goes unanswered.
          this.notify('Voice dropped — you are no longer on the intercom')
          return
        }
        const heard = this.listenIdOf(room)
        if (heard === undefined) return
        // The same reasoning, smaller: a channel somebody chose to keep an
        // ear on has gone quiet, and silence is what it sounds like when
        // nobody is talking. Said, or it reads as a quiet channel.
        this.listens.delete(heard)
        this.removeAudio(room)
        this.publishListening()
        this.notify(`Stopped hearing ${this.nameOf(heard)} — its connection dropped`)
      })
  }

  private setListenStatus(room: Room, status: VoiceListen['status']): void {
    const id = this.listenIdOf(room)
    const entry = id === undefined ? undefined : this.listens.get(id)
    if (!entry) return
    entry.status = status
    this.publishListening()
  }

  private refresh(room: Room): void {
    if (this.room === room) this.publishParticipants()
    else if (this.listenIdOf(room) !== undefined) this.publishListening()
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
          // Whatever the crew member is asking for *now*, not a hardcoded
          // false: the capture takes a moment, and a push-to-talk press
          // inside that window was undone by this line — the button held
          // down, the mic shut, and nothing saying so.
          await room.localParticipant.setMicrophoneEnabled(this.talking)
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

  /** Leave voice: the talk channel and every channel being heard. */
  async leave(): Promise<void> {
    const rooms = [this.room, ...[...this.listens.values()].map((l) => l.room)]
    this.room = null
    this.channelId = null
    this.listens.clear()
    await Promise.all(rooms.map((room) => room?.disconnect()))
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
    // Every room from the one tap: a gesture is spent once it has been
    // handled, and a second "Tap to hear" per channel would be a game.
    const heard = [...this.listens.values()].map((l) => l.room.startAudio())
    let refused = false
    try {
      await room.startAudio()
    } catch {
      refused = true
    }
    if (heard.length > 0) {
      const results = await Promise.allSettled(heard)
      refused ||= results.some((r) => r.status === 'rejected')
    }
    this.publish({ audioBlocked: refused || this.playbackBlocked() })
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
        // An empty list is "this browser will not tell us", not "your
        // headset is gone". Before the microphone permission is granted,
        // enumerateDevices returns entries with blank ids that the filter
        // above drops — so this ran on every join, decided the saved device
        // had vanished, and erased it. The crew member's chosen headset was
        // forgotten before they were even asked for permission to use it.
        if (available.length === 0) continue
        const { fellBack } = resolveDevice(savedDeviceId(kind), available)
        if (fellBack) {
          saveDeviceId(kind, null)
          this.publish(
            kind === 'audioinput'
              ? { selectedInput: null, error: 'Mic disconnected — using default' }
              : { selectedOutput: null, error: 'Speaker disconnected — using default' }
          )
          if (this.room) void this.room.switchActiveDevice(kind, 'default')
          for (const { room } of this.listens.values()) {
            void room.switchActiveDevice(kind, 'default').catch(() => {})
          }
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
    // Every room's, not only the talk room's: a speaker plays them all, and
    // a channel heard now captures with this mic the moment it is talked on
    // (LiveKit keeps it as the room's capture default until then).
    for (const { room } of this.listens.values()) {
      void room.switchActiveDevice(kind, deviceId ?? 'default').catch(() => {})
    }
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

  // -- how it actually sounded -----------------------------------------------

  /**
   * Ask every subscribed track's decoder what it had to do to keep up.
   *
   * The box can measure its own network all day and it will always look
   * healthy from where it is standing. This is the only vantage point that
   * can say a crew member's comms were breaking up, because the concealment
   * counters live in the decoder that did the concealing.
   *
   * Failures here are silent by design: this is telemetry for a graph, and a
   * browser that withholds a counter must not cost anyone their intercom.
   */
  private startQosSampling(): void {
    this.stopQosSampling()
    this.qosTimer = window.setInterval(() => void this.sampleQos(), QOS_INTERVAL_MS)
  }

  private stopQosSampling(): void {
    if (this.qosTimer !== null) clearInterval(this.qosTimer)
    this.qosTimer = null
    this.qosPrevious.clear()
  }

  private async sampleQos(): Promise<void> {
    if (!this.room) return
    const readings: VoiceQos[] = []
    const seen = new Set<string>()
    // Every channel being heard, not only the one talked on: comms breaking
    // up on a channel somebody is monitoring is still comms breaking up.
    const participants = [this.room, ...[...this.listens.values()].map((l) => l.room)].flatMap(
      (room) => [...room.remoteParticipants.values()]
    )

    for (const participant of participants) {
      for (const publication of participant.audioTrackPublications.values()) {
        // Audio by construction, but the SDK types the map's value as any
        // remote track — and an older client may not carry the stats call at
        // all, which is a missing graph rather than a broken intercom.
        const track = publication.track as RemoteAudioTrack | undefined
        if (!track) continue
        seen.add(publication.trackSid)
        try {
          const next = await inboundAudioSample(track)
          if (!next) continue
          const prev = this.qosPrevious.get(publication.trackSid)
          this.qosPrevious.set(publication.trackSid, next)
          if (!prev) continue
          const qos = qosBetween(prev, next)
          if (qos) readings.push(qos)
        } catch {
          // A browser that won't answer is not a fault worth surfacing.
        }
      }
    }

    // Forget tracks that have gone, or a long shift slowly fills this with
    // people who left hours ago.
    for (const sid of [...this.qosPrevious.keys()]) {
      if (!seen.has(sid)) this.qosPrevious.delete(sid)
    }

    const worst = worstQos(readings)
    if (worst) this.reportQos(worst)
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
        listening: false,
      },
      ...[...room.remoteParticipants.values()].map((p) => ({
        id: p.identity,
        name: p.name || p.identity,
        speaking: speakingIds.has(p.identity),
        quality: toQuality(p.connectionQuality),
        // Here to hear, not to talk: they are listening in from their own
        // talk channel (or have no microphone). Everyone in a talk room
        // publishes a muted mic as they join, so no mic is the tell.
        listening: p.audioTrackPublications.size === 0,
      })),
    ]
    this.publish({ participants: list })
  }

  private publishListening(): void {
    const listening: VoiceListen[] = [...this.listens].map(([channelId, { room, status }]) => {
      const me = room.localParticipant.identity
      return {
        channelId,
        status,
        speaking: room.activeSpeakers
          .filter((p) => p.identity !== me)
          .map((p) => p.name || p.identity),
        others: room.remoteParticipants.size,
      }
    })
    this.publish({ listening })
  }

  private reset(error: string | null = null): void {
    this.talking = false
    this.stopMicTest()
    this.stopQosSampling()
    for (const els of this.audioEls.values()) for (const el of els) el.remove()
    this.audioEls.clear()
    // Every channel being heard goes with the talk channel: they ride on its
    // call (see `listen`), and a drop that left them playing would leave
    // somebody hearing comms with no voice bar to say they are on it.
    const heard = [...this.listens.values()].map((l) => l.room)
    this.listens.clear()
    for (const room of heard) void room.disconnect().catch(() => {})
    // Hang up on the way out. `reset` used to only drop the reference, so a
    // join that failed after `connect` had already succeeded left a live
    // room with nothing pointing at it: the crew member vanished from their
    // own UI while staying in the SFU's participant list, and the next join
    // arrived as a second device belonging to the same person.
    const room = this.room
    this.room = null
    this.channelId = null
    if (room) void room.disconnect().catch(() => {})
    void this.mixCtx?.close().catch(() => {})
    this.mixCtx = null
    releaseCallAudio()
    this.publish({ ...initialVoiceState, devices: initialVoiceState.devices, error })
  }
}
