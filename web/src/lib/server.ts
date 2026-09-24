/**
 * Where is the crew server? For the PWA the answer is always "same origin"
 * (the server serves the bundle). Native wrappers load the bundle from the
 * app package instead, so they carry a configured server origin — stored in
 * localStorage and applied to every API/WS/file URL.
 */
import type { FileMeta } from '@crewbox/shared'
import { fileUrl } from '@crewbox/shared'

const SERVER_KEY = 'crewbox:server-url'

interface AlertsPlugin {
  start(options: { serverUrl: string; token: string; myName: string }): Promise<void>
  stop(): Promise<void>
}

/**
 * Capacitor's App plugin, as the native side puts it on the page. The web app
 * does not bundle @capacitor/core, so this is the raw bridge: `addListener`
 * returns a handle rather than a promise. Only Android fires `backButton`.
 */
interface AppPlugin {
  addListener(event: 'backButton', listener: (event: { canGoBack: boolean }) => void): unknown
  /**
   * A link to the app, `crewbox://join` (lib/appLinks.ts): one tapped while it
   * runs, and the one that started it, held until the page listens.
   */
  addListener(event: 'appUrlOpen', listener: (event: { url: string }) => void): unknown
  minimizeApp(): Promise<void>
  /** Android: the link that started the app. An iPhone: the last link opened. */
  getLaunchUrl?(): Promise<{ url: string } | undefined>
}

/** Android's side of voice (native/android VoicePlugin). */
interface VoicePlugin {
  /** Before a join opens any audio: asks about Bluetooth once, when it matters. */
  prepare(): Promise<void>
}

/** Capacitor's Haptics plugin: the platform's own vibration, in both apps. */
interface HapticsPlugin {
  notification(options: { type: 'SUCCESS' | 'WARNING' | 'ERROR' }): Promise<void>
}

/**
 * Capacitor's SystemBars plugin, built into Capacitor 8 on both platforms.
 * The style names the bar, not its text: `DARK` gets light text.
 */
interface SystemBarsPlugin {
  setStyle(options: { style: 'DARK' | 'LIGHT' | 'DEFAULT' }): Promise<void>
}

/**
 * A crew box the app's own code found on the Wi-Fi: one `_crewbox._tcp`
 * service, resolved (docs/DISCOVERY.md). What it says is the box's word, and
 * anything on the Wi-Fi can say it.
 */
export interface FoundService {
  /** The service's instance name: the event's name, perhaps cut or numbered. */
  name: string
  /** Its IPv4 addresses. */
  addresses: string[]
  port: number
  /** Its TXT record, keys lower case, '' for a key given with no value. */
  txt: Record<string, string>
}

/** How the app's search for boxes is going, as the native side sees it. */
export type SearchState = 'searching' | 'waiting' | 'denied' | 'failed'

/** A listener handle from the raw bridge, which returns one rather than a promise. */
interface ListenerHandle {
  remove(): unknown
}

/**
 * Both apps' search for boxes on the Wi-Fi (native DiscoveryPlugin): the
 * iPhone's NWBrowser, Android's NsdManager. Each `boxes` event is the whole
 * list as it stands.
 */
export interface DiscoveryPlugin {
  start(): Promise<void>
  stop(): Promise<void>
  /** iPhone only: the app's page in Settings, where Local Network is switched on. */
  openSettings?(): Promise<void>
  addListener(event: 'boxes', listener: (event: { boxes: FoundService[] }) => void): ListenerHandle
  addListener(
    event: 'state',
    listener: (event: { state: SearchState; reason?: string }) => void
  ): ListenerHandle
}

/** A file for the Android app to save or share: built here (base64), or on the box. */
export type FilePayload = { filename: string; mime: string } & (
  { data: string; url?: never } | { url: string; data?: never }
)

/** Android's save and share (native/android FilesPlugin). */
export interface FilesPlugin {
  /**
   * Into Downloads on Android 10 and later; where the phone's "save as"
   * screen says on older ones, where `saved` is false if it was backed out
   * of. `name` is what the file ended up called, which a clash can change.
   */
  save(file: FilePayload): Promise<{ saved: boolean; name?: string; folder?: string }>
  /** The share sheet, with the file attached. Resolves once the sheet is up. */
  share(file: FilePayload): Promise<void>
}

/** What the scanner came back with. */
export type ScanOutcome =
  | { result: 'scanned'; text: string }
  /** Backed out of, with nothing read. */
  | { result: 'cancelled' }
  /** The camera isn't allowed for the app. `openSettings` is the way back. */
  | { result: 'denied' }
  /**
   * This phone can't scan: no camera, a camera switched off by a profile or
   * policy, or on an iPhone, a chip older than the A12.
   */
  | { result: 'unavailable' }

/**
 * Android's answer on the camera: `granted`, or not (yet): `prompt` and
 * `prompt-with-rationale` when asking would show the question, `denied` when
 * Capacitor has seen Android stop asking.
 */
export type CameraPermission = 'granted' | 'denied' | 'prompt' | 'prompt-with-rationale'

/**
 * Both apps' QR scanner (native ScannerPlugin): VisionKit's data scanner on
 * the iPhone, and on Android CameraX for the picture with ZXing to read it.
 * Both read on the phone with no network, and hand back the first QR code's
 * text as it is.
 */
export interface ScannerPlugin {
  /** Opens the camera until a QR code is read or the crew member backs out. */
  scan(): Promise<ScanOutcome>
  /** The app's page in the phone's settings, where the camera is allowed. */
  openSettings(): Promise<void>
  /**
   * Android only, and Capacitor's own: whether the app may use the camera,
   * which "Take a photo" in the attach menu needs as much as the scanner.
   */
  checkPermissions?(): Promise<{ camera: CameraPermission }>
}

/** A Wi-Fi network for the apps to join, as a scanned `WIFI:` code gives it (lib/joinCode.ts). */
export interface WifiNetwork {
  ssid: string
  /** '' for an open network. */
  password: string
  /** WPA3 alone (`T:SAE`), which Android has to be told. The iPhone's join has no such setting. */
  wpa3: boolean
  hidden: boolean
}

/** What asking the phone to join a network came to. */
export type WifiOutcome =
  /** On it: an iPhone checks once it has joined, and says so if it was on it already. */
  | { result: 'joined' }
  /** Android saved it, and has been asked to join it by its own settings screen. */
  | { result: 'saved' }
  /** Android has it saved already, as the code gives it, so asked nothing. */
  | { result: 'known' }
  /**
   * Not saved: turned down at the phone's question, or on Android, a phone
   * that doesn't offer the question (a guest user, or a work profile's rules).
   */
  | { result: 'declined' }
  /** The iPhone saved it and isn't on it after waiting: out of range, or a wrong password. */
  | { result: 'failed' }
  /** The phone refused the code's name or password without asking anything. */
  | { result: 'invalid' }
  /** Not done, and nothing to say why: Android 10 and older, or the phone erred. */
  | { result: 'unavailable' }

/**
 * Both apps' way onto a Wi-Fi network from its code (native WifiPlugin): on
 * the iPhone NEHotspotConfiguration, which iOS asks the crew member about; on
 * Android 11 and later the phone's own "Save this network?" screen, which
 * joins the network once saved. Either way the network is saved on the phone
 * as one joined in its settings is, and the phone asks before it is.
 */
export interface WifiPlugin {
  join(network: WifiNetwork): Promise<WifiOutcome>
}

declare global {
  interface Window {
    Capacitor?: {
      isNativePlatform?: () => boolean
      getPlatform?: () => string
      Plugins?: {
        CrewboxAlerts?: AlertsPlugin
        App?: AppPlugin
        CrewboxVoice?: VoicePlugin
        Haptics?: HapticsPlugin
        SystemBars?: SystemBarsPlugin
        CrewboxFiles?: FilesPlugin
        CrewboxDiscovery?: DiscoveryPlugin
        CrewboxScanner?: ScannerPlugin
        CrewboxWifi?: WifiPlugin
      }
    }
  }
}

/** True when running inside a Capacitor native shell. */
export function isNative(): boolean {
  return typeof window !== 'undefined' && !!window.Capacitor?.isNativePlatform?.()
}

/** True inside the Android app, as opposed to the iPhone app or any browser. */
export function isAndroidApp(): boolean {
  return isNative() && window.Capacitor?.getPlatform?.() === 'android'
}

/** True inside the iPhone app, as opposed to the Android app or any browser. */
export function isIosApp(): boolean {
  return isNative() && window.Capacitor?.getPlatform?.() === 'ios'
}

/** The Android background-alerts bridge, when present (native builds only). */
export function nativeAlerts(): AlertsPlugin | undefined {
  return window.Capacitor?.Plugins?.CrewboxAlerts
}

/** Capacitor's App plugin: the back button and the app's lifecycle (native only). */
export function nativeApp(): AppPlugin | undefined {
  return window.Capacitor?.Plugins?.App
}

/** The Android voice bridge, when present (Android builds only). */
export function nativeVoice(): VoicePlugin | undefined {
  return window.Capacitor?.Plugins?.CrewboxVoice
}

/** Capacitor's Haptics plugin (native only). */
export function nativeHaptics(): HapticsPlugin | undefined {
  return window.Capacitor?.Plugins?.Haptics
}

/** Capacitor's SystemBars plugin: the colour of the status bar's text (native only). */
export function nativeSystemBars(): SystemBarsPlugin | undefined {
  return window.Capacitor?.Plugins?.SystemBars
}

/** The Android app's save and share, when present (Android builds only). */
export function nativeFiles(): FilesPlugin | undefined {
  return window.Capacitor?.Plugins?.CrewboxFiles
}

/** The apps' search for boxes on the Wi-Fi, when present (native builds only). */
export function nativeDiscovery(): DiscoveryPlugin | undefined {
  return window.Capacitor?.Plugins?.CrewboxDiscovery
}

/** The apps' QR scanner, when present (native builds only). */
export function nativeScanner(): ScannerPlugin | undefined {
  return window.Capacitor?.Plugins?.CrewboxScanner
}

/** The apps' way onto a Wi-Fi network from its code, when present (native builds only). */
export function nativeWifi(): WifiPlugin | undefined {
  return window.Capacitor?.Plugins?.CrewboxWifi
}

/**
 * Whether the Android app may use the camera: false when it may not, and
 * undefined when there is nobody to ask, as in a browser or the iPhone app.
 */
export async function cameraAllowed(): Promise<boolean | undefined> {
  const scanner = nativeScanner()
  if (!scanner?.checkPermissions) return undefined
  try {
    const { camera } = await scanner.checkPermissions()
    return camera === 'granted'
  } catch {
    return undefined
  }
}

/**
 * Normalize user input into an origin: adds http:// when no scheme is given
 * (native LAN use — the whole point is not needing certificates), strips
 * paths and trailing slashes. Returns '' for empty/invalid input.
 */
export function normalizeOrigin(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ''
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  try {
    return new URL(withScheme).origin
  } catch {
    return ''
  }
}

/**
 * Whether the iPhone app refuses this origin before a request leaves the phone.
 *
 * App Transport Security lets the app use plain HTTP only where its
 * `NSAllowsLocalNetworking` exemption reaches: IP addresses, `.local` names,
 * and names with no dot in them (Apple's documentation of that key). Plain
 * HTTP to any other name fails every request inside the phone, which on
 * screen is exactly a box that is switched off. The box itself only ever
 * advertises a name when it has a certificate for it, so this is somebody
 * typing a name the box is also known by, without `https://`.
 */
export function iphoneRefusesPlainHttp(origin: string): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:') return false
  const host = url.hostname
  // A parsed URL writes every IPv4 address as a dotted quad, and IPv6 in brackets.
  const ip = host.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(host)
  return !ip && host.includes('.') && !host.endsWith('.local')
}

/** The configured server origin, or '' meaning same-origin (PWA default). */
export function serverOrigin(): string {
  try {
    return localStorage.getItem(SERVER_KEY) ?? ''
  } catch {
    return ''
  }
}

/** Where this page reaches its box: the configured origin, or the page's own. */
export function boxOrigin(): string {
  return serverOrigin() || location.origin
}

export function setServerOrigin(input: string): void {
  const origin = normalizeOrigin(input)
  if (origin) localStorage.setItem(SERVER_KEY, origin)
  else localStorage.removeItem(SERVER_KEY)
}

/** Prefix a server-relative path (e.g. `/api/join`) with the configured origin. */
export function apiUrl(path: string): string {
  return serverOrigin() + path
}

/** The WebSocket endpoint, honouring the configured origin's scheme. */
export function wsUrl(): string {
  const origin = serverOrigin()
  if (origin) return origin.replace(/^http/i, 'ws') + '/ws'
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/ws`
}

/** The shared-docs WebSocket base; providers append /<module>/<room>. */
export function docsWsUrl(): string {
  return wsUrl() + '/docs'
}

/** Absolute URL for a shared file — shareable/copyable off-device. */
export function absoluteFileUrl(file: FileMeta): string {
  return (serverOrigin() || location.origin) + fileUrl(file)
}

/** Human label for where the app is trying to connect (diagnostics copy). */
export function serverLabel(): string {
  const origin = serverOrigin()
  return origin ? origin.replace(/^https?:\/\//i, '') : location.host
}
