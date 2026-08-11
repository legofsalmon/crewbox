/**
 * Voice UI state, split from voice.ts so the store can render voice UI
 * without pulling the LiveKit SDK into the entry bundle — VoiceManager
 * (and livekit-client with it) loads on first use via dynamic import.
 */
import { canSelectOutput, type DeviceInfo } from './devices.ts'

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
  /**
   * The browser is refusing to play the audio until someone taps.
   *
   * Its own state rather than an `error`, because it is not a failure and it
   * is recoverable by exactly one gesture. Being connected to comms and
   * hearing nothing, with the UI insisting all is well, is the worst of the
   * available outcomes — so this drives a control rather than a message.
   */
  audioBlocked: boolean
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
  audioBlocked: false,
  devices: { inputs: [], outputs: [], canSelectOutput: canSelectOutput() },
  selectedInput: null,
  selectedOutput: null,
  error: null,
}
