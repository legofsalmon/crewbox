/* tslint:disable */
/* eslint-disable */

export type Severity = "info" | "warning" | "error";

export type Essence =
| "video" | "compressed-video" | "audio" | "aes3" | "ancillary"
| "fast-metadata" | "timed-text" | "sdi" | "unknown";

/** One finding. `line` counts from 1; `stream` indexes `Report.streams`. */
export interface Diagnostic {
    rule: string;
    severity: Severity;
    message: string;
    line: number | null;
    stream: number | null;
    reference: string;
}

export type RefClock =
| { type: "ptp"; version: string; grandmaster: string | null; domain: number | null; traceable: boolean }
| { type: "local-mac"; address: string }
| { type: "other"; value: string };

export type MediaClock =
| { type: "direct"; offset: number | null }
| { type: "sender" }
| { type: "other"; value: string };

export interface Param {
    name: string;
    value: string | null;
    quoted: boolean;
}

/** One media section. */
export interface Stream {
    index: number;
    line: number;
    media: string;
    essence: Essence;
    mid: string | null;
    destination: string | null;
    port: number | null;
    source: string | null;
    payload_type: number | null;
    encoding: string | null;
    clock_rate: number | null;
    channels: number | null;
    reference_clock: RefClock | null;
    media_clock: MediaClock | null;
    parameters: Param[];
    summary: string;
    /** Bits per second of pixels or samples, before any headers. */
    payload_bitrate: number | null;
}

export interface Report {
    streams: Stream[];
    diagnostics: Diagnostic[];
}

export interface Rule {
    id: string;
    severity: Severity;
    reference: string;
    summary: string;
}

/** What a Sender's manifest_href returned. */
export interface Manifest {
    url: string;
    status?: number;
    sdp?: string;
    error?: string;
}

/** Resources as the IS-04 Query API returned them, and each Sender's SDP file by Sender id. */
export interface Snapshot {
    source?: string;
    api_version?: string;
    nodes?: object[];
    devices?: object[];
    sources?: object[];
    flows?: object[];
    senders?: object[];
    receivers?: object[];
    manifests?: Record<string, Manifest>;
    /** What each Sender's Connection API serves at /transportfile, where manifest_href names another URL. */
    transport_files?: Record<string, Manifest>;
}

export type ResourceKind = "node" | "device" | "source" | "flow" | "sender" | "receiver";

/** `index` is the resource's position in its Snapshot list. */
export interface ResourceRef {
    kind: ResourceKind;
    id: string | null;
    label: string;
    index: number;
}

/** One registry finding. `line` is set for findings in a Sender's SDP file. */
export interface Finding {
    rule: string;
    severity: Severity;
    message: string;
    reference: string;
    resource: ResourceRef | null;
    line: number | null;
}

export interface SenderView {
    id: string | null;
    label: string;
    node: string | null;
    device: string | null;
    transport: string | null;
    active: boolean | null;
    flow_id: string | null;
    media_type: string | null;
    manifest_href: string | null;
    /** The streams in its SDP file, when the file was fetched. */
    streams: Stream[];
    /** Ids of the Receivers taking its stream. */
    receivers: string[];
}

export interface ReceiverView {
    id: string | null;
    label: string;
    node: string | null;
    device: string | null;
    transport: string | null;
    format: string | null;
    active: boolean;
    sender_id: string | null;
    sender_label: string | null;
}

export interface Grandmaster {
    id: string;
    clocks: number;
}

export interface RegistrySummary {
    nodes: number;
    devices: number;
    sources: number;
    flows: number;
    senders: number;
    receivers: number;
    active_senders: number;
    active_receivers: number;
    grandmasters: Grandmaster[];
    unlocked_clocks: number;
}

export interface RegistryReport {
    source: string | null;
    api_version: string | null;
    summary: RegistrySummary;
    senders: SenderView[];
    receivers: ReceiverView[];
    findings: Finding[];
}

/** One Receiver's row: `fits` and `current` are positions in RoutingMatrix.senders. */
export interface MatrixRow {
    receiver: ResourceRef;
    fits: number[];
    current: number | null;
}

/** Which Senders each Receiver can take, both in label order. */
export interface RoutingMatrix {
    senders: ResourceRef[];
    receivers: MatrixRow[];
}

/** One IS-05 constraint on a transport parameter. */
export interface Constraint {
    enum?: unknown[];
    minimum?: number;
    maximum?: number;
    pattern?: string;
    description?: string;
}

export interface ConnectionOptions {
    /** The SDP file of the stream to take; leave it out to disconnect the Receiver. */
    sdp?: string;
    /** The Receiver's /constraints, one object per leg, as its Connection API returns them. */
    constraints?: Record<string, Constraint>[];
    /** The Sender whose stream it is; null or left out for one from outside NMOS. */
    senderId?: string | null;
    /** When it takes effect: "now" (the default), or a PTP time such as "1790510437:0" or UTC time such as "2026-09-27T12:00:00Z" still to come. */
    at?: string;
    /** Seconds after the Connection API has the request, in place of `at`. NaN and Infinity are refused. */
    in?: number;
    taiUtc?: number;
}

/** One stream a Receiver joins: the only one, or one leg of an ST 2022-7 pair. */
export interface Leg {
    destination: string;
    multicast: boolean;
    source_ip: string | null;
    destination_port: number;
}

export interface ConnectionPlan {
    /** The body to PATCH to the Receiver's /staged endpoint. */
    request: Record<string, unknown>;
    /** What its /active endpoint should show once the change takes effect. */
    expect: { sender_id: string | null; master_enable: boolean; legs: (Leg | null)[] };
    notes: string[];
    /** Why the Receiver would refuse the request, judged against its constraints. */
    problems: string[];
}

/** A PTP timestamp as sent: 48-bit seconds and nanoseconds. */
export interface PtpTimestamp {
    seconds: number;
    nanoseconds: number;
}

export interface PortIdentity {
    clock: string;
    port: number;
}

export interface PtpHeader {
    /** "Sync", "Announce", "Management" and so on. */
    message_type: string;
    major_sdo_id: number;
    version: number;
    minor_version: number;
    message_length: number;
    domain: number;
    minor_sdo_id: number;
    /** The flags that are set, such as "two-step" or "PTP timescale". */
    flags: string[];
    correction_ns: number;
    message_type_specific: number;
    source: PortIdentity;
    sequence_id: number;
    control: number;
    /** log2 of the seconds between messages; 127 where the message type has none. */
    log_message_interval: number;
}

export interface ClockQuality {
    class: number;
    accuracy: number;
    variance: number;
}

export type PtpBody =
| { type: "sync" | "delay_req" | "pdelay_req"; origin: PtpTimestamp }
| { type: "pdelay_resp"; request_receipt: PtpTimestamp; requesting: PortIdentity }
| { type: "follow_up"; precise_origin: PtpTimestamp }
| { type: "delay_resp"; receive: PtpTimestamp; requesting: PortIdentity }
| { type: "pdelay_resp_follow_up"; response_origin: PtpTimestamp; requesting: PortIdentity }
| {
    type: "announce";
    origin: PtpTimestamp;
    current_utc_offset: number;
    priority1: number;
    quality: ClockQuality;
    priority2: number;
    grandmaster: string;
    steps_removed: number;
    time_source: number;
}
| { type: "signaling"; target: PortIdentity }
| {
    type: "management";
    target: PortIdentity;
    starting_boundary_hops: number;
    boundary_hops: number;
    /** "GET", "SET", "RESPONSE", "COMMAND" or "ACKNOWLEDGE". */
    action: string;
}
| { type: "reserved" };

/** The ST 2059-2 synchronization metadata. Times are PTP seconds; offsets are seconds. */
export interface SyncMetadata {
    frame_rate_numerator: number;
    frame_rate_denominator: number;
    /** "unavailable", "internal", "cold locking", "warm locking" or "externally locked". */
    locking_status: string;
    time_address_flags: number;
    current_local_offset: number;
    jump_seconds: number;
    time_of_next_jump: number;
    time_of_next_jam: number;
    time_of_previous_jam: number;
    previous_jam_local_offset: number;
    daylight_saving: number;
    leap_second_jump: number;
}

export type TlvContent =
| { kind: "management"; id: number }
| { kind: "path_trace"; clocks: string[] }
| ({ kind: "sync_metadata" } & SyncMetadata)
| { kind: "organization_extension"; organization: string; subtype: string }
| { kind: "other" };

export interface Tlv {
    type: number;
    /** The value in hex. */
    value: string;
    content: TlvContent;
}

export type TlvError =
| { kind: "overrun"; offset: number; tlv_type: number; length: number; available: number }
| { kind: "trailing"; offset: number; count: number };

export interface PtpMessage {
    header: PtpHeader;
    body: PtpBody;
    tlvs: Tlv[];
    tlv_error: TlvError | null;
}

export interface PtpFinding {
    rule: string;
    severity: Severity;
    message: string;
    reference: string;
}

/** A decoded message: lines describing it, its fields, and what breaks ST 2059-2. */
export interface DecodedPtp {
    summary: string[];
    message: PtpMessage;
    findings: PtpFinding[];
}

export interface TimingOptions {
    /** PTP time, "1790510437.123456789" or "1790510437:123456789", or UTC,
     *  "2026-09-27T12:00:00Z" as toISOString writes it. Now when omitted. */
    at?: string;
    /** TAI − UTC in seconds, at most a day either way; 37 when omitted. */
    taiUtc?: number;
    /** Seconds from PTP time to Local Time (currentLocalOffset), at most a day either way;
     *  UTC when omitted. */
    localOffset?: number;
    /** Video frame rates: 50, "60000/1001", 59.94. */
    video?: (number | string)[];
    /** Audio sampling rates in Hz. */
    audio?: number[];
    /** The last daily jam, a whole second of PTP or UTC time and not after `at`; the last
     *  Local Time midnight when omitted. */
    jam?: string;
    /** The local offset when the jam happened (previousJamLocalOffset), which time code
     *  keeps until the next jam; localOffset when omitted. */
    jamLocalOffset?: number;
    /** Whether 30000/1001 time code drops frames; true when omitted. */
    dropFrame?: boolean;
}

/** Times are PTP times, "seconds.nanoseconds", or calendar times, "YYYY-MM-DD hh:mm:ss.nnnnnnnnn". */
export interface Timecode {
    address: string;
    rate: string;
    drop_frame: boolean;
    jam: string;
    jam_local: string;
}

export interface VideoTiming {
    rate: string;
    frame: number;
    frame_start: string;
    next_frame: string;
    /** RTP timestamps at 90 kHz. */
    rtp: number;
    next_rtp: number;
    timecode: Timecode | null;
}

export interface AudioTiming {
    rate: number;
    rtp: number;
    block: number;
    block_start: string;
    next_block: string;
}

export interface Timing {
    ptp: string;
    utc: string;
    tai_utc: number;
    local: string;
    local_offset: number;
    video: VideoTiming[];
    audio: AudioTiming[];
}

export interface CaptureOptions {
    /** SDP files of streams in the capture; each flow is checked against the stream it
     *  matches, and flows without one are recognised from their packets. */
    sdp?: { name: string; text: string }[];
    /** The clock the capture's timestamps count: "auto" works it out from PTP Sync
     *  messages, or else the RTP timestamps; "auto" when omitted. */
    timescale?: "auto" | "ptp" | "utc";
    /** TAI − UTC in seconds, for a capture on UTC, at most a day either way; 37 when omitted. */
    taiUtc?: number;
}

/** The minimum, maximum and mean of a measurement. */
export interface Stats {
    count: number;
    min: number;
    max: number;
    mean: number;
}

export interface CaptureFile {
    /** "pcap", "pcap (nanosecond)" or "pcapng". */
    format: string;
    frames: number;
    /** When the first frame was captured, by the capturing clock: "seconds.nanoseconds" since 1970. */
    start: string | null;
    /** Seconds from the first frame to the last. */
    duration: number;
    bytes: number;
    udp: number;
    rtp: number;
    /** RTP packets in flows past the first 10,000, counted in rtp but not measured. */
    rtp_untracked: number;
    ptp: number;
    /** IP fragments after the first, which carry no UDP header. */
    fragments: number;
    other: number;
    /** Why the file could not be read to the end, when it could not. */
    error: string | null;
}

export interface CaptureTimescale {
    clock: "ptp" | "utc" | "unknown";
    /** What decided it. */
    basis: string;
    /** Nanoseconds added to the capture's timestamps to give PTP time. */
    shift: number;
    /** Anything that limits the measurements that need PTP time. */
    note: string | null;
}

/** The network compatibility model (ST 2110-21 §6.6.1). */
export interface CinstReport {
    peak: number;
    sender_type: string | null;
    cmax: number | null;
    signalled_cmax: number | null;
    cmax_narrow: number;
    cmax_narrow_linear: number;
    cmax_wide: number | null;
    /** The sender types whose CMAX the peak fits. */
    fits: string[];
    drain_us: number;
}

/** The virtual receiver buffer (ST 2110-21 §6.6.2). */
export interface VrxReport {
    schedule: "gapped" | "linear";
    troffset_us: number;
    troffset_signalled: boolean;
    vrxfull: number;
    peak: number;
    underflows: number;
    overflows: number;
    /** From each packet's arrival to its read time. */
    margin_us: Stats | null;
    method: string;
}

/** One second of a video stream: PTP seconds when the capture's clock is known. */
export interface VideoWindow {
    second: number;
    fpt: Stats | null;
    rtp_offset: Stats | null;
    latency: Stats | null;
    gap: Stats | null;
    cinst: number | null;
    vrx: number | null;
}

/** RP 2110-25 measurements of video and ancillary data. Times are in microseconds, RTP
 *  offsets in 90 kHz ticks. */
export interface VideoReport {
    frame_rate: string | null;
    height: number | null;
    interlaced: boolean;
    segmented: boolean;
    /** Frames, or fields of interlaced video. */
    units: number;
    packets_per_frame: Stats | null;
    npackets: number | null;
    /** First packet time, from each frame's reference time. */
    fpt: Stats | null;
    rtp_offset: Stats | null;
    latency: Stats | null;
    gap: Stats | null;
    cinst: CinstReport | null;
    vrx: VrxReport | null;
    models_skipped: string | null;
    vrx_skipped: string | null;
    windows: VideoWindow[];
}

export interface AudioWindow {
    second: number;
    latency: Stats | null;
    interval: Stats | null;
    ts_df: number | null;
}

/** Audio measurements. Times are in microseconds. */
export interface AudioReport {
    encoding: string;
    sample_rate: number;
    channels: number | null;
    samples_per_packet: number | null;
    packet_time_us: number | null;
    latency: Stats | null;
    interval: Stats | null;
    /** The timestamped delay factor of each 200 ms (EBU Tech 3337). */
    ts_df: Stats | null;
    windows: AudioWindow[];
}

/** One RTP flow. `first` and `last` are seconds since the capture began. */
export interface FlowReport {
    index: number;
    source: string;
    destination: string;
    essence: Essence;
    /** The SDP stream it matched, such as "camera1.sdp stream 0". */
    sdp: string | null;
    /** True when the essence was worked out from the packets. */
    guessed: boolean;
    payload_type: number;
    ssrc: string;
    packets: number;
    bytes: number;
    first: number;
    last: number;
    mbps: number | null;
    lost: number;
    out_of_order: number;
    duplicates: number;
    video: VideoReport | null;
    audio: AudioReport | null;
}

export interface MessageCount {
    kind: string;
    count: number;
    log_interval: number | null;
    interval_ms: Stats | null;
}

export interface PtpPortReport {
    port: string;
    address: string;
    messages: MessageCount[];
}

export interface PtpDomainReport {
    domain: number;
    /** The grandmasters that Announce messages named, in order, up to 16. */
    grandmasters: string[];
    ports: PtpPortReport[];
    /** From a Sync leaving the grandmaster to its arrival, in microseconds. */
    sync_offset_us: Stats | null;
}

export interface CapturePtp {
    messages: number;
    undecodable: number;
    /** Messages from ports past the first 10,000, counted in messages but not followed. */
    untracked: number;
    domains: PtpDomainReport[];
}

/** One capture finding. `flow` is a FlowReport index; `at` is seconds since the capture began. */
export interface CaptureFinding {
    rule: string;
    severity: Severity;
    message: string;
    reference: string;
    flow: number | null;
    domain: number | null;
    at: number | null;
    count: number;
}

export interface CaptureReport {
    capture: CaptureFile;
    timescale: CaptureTimescale;
    flows: FlowReport[];
    ptp: CapturePtp;
    /** Streams in the SDP files that no flow matched. */
    missing: string[];
    findings: CaptureFinding[];
}



/**
 * Analyses a packet capture, a pcap or pcapng file: measures each RTP flow and the PTP
 * messages as RP 2110-25 describes, and checks them against the standards. Throws when
 * the octets are not a capture; one that ends partway through is analysed as far as it
 * goes, and `capture.error` says why it stopped.
 */
export function analyseCapture(capture: Uint8Array, options?: CaptureOptions): CaptureReport;

/**
 * Checks a registry snapshot: its resources, PTP clocks, connections and every
 * Sender's SDP file. Takes the snapshot as an object or as JSON text.
 */
export function checkRegistry(snapshot: Snapshot | string): RegistryReport;

/**
 * Decodes one PTP message, such as the payload of a UDP datagram to port 319 or 320,
 * and checks it against ST 2059-2. Throws when the octets are not a PTP version 2
 * message.
 */
export function decodePtp(message: Uint8Array): DecodedPtp;

/**
 * Checks an SDP file: describes each stream and lists every finding in line order.
 */
export function lint(sdp: string): Report;

/**
 * Plans connecting a Receiver to the stream an SDP file describes, as IS-05 asks of a
 * controller: the request for its `/staged` endpoint, with each leg's transport
 * parameters, and the problems its constraints would raise. Without `sdp`, plans
 * disconnecting it. Sending the request, and fetching what it needs, is left to the page.
 */
export function planConnection(options: ConnectionOptions): ConnectionPlan;

/**
 * Which Senders each Receiver in a registry snapshot can take, by transport, format
 * and capabilities: the crosspoint matrix. Takes the snapshot as `checkRegistry` does.
 */
export function routingMatrix(snapshot: Snapshot | string): RoutingMatrix;

/**
 * Every rule: the SDP file rules, then the registry rules, the PTP message rules and
 * the capture rules.
 */
export function rules(): Rule[];

/**
 * Works out where a PTP time falls, by ST 2059-1: for each video frame rate its frame,
 * RTP timestamps and time code, and for each audio rate its RTP timestamp and AES3 block.
 */
export function timing(options?: TimingOptions): Timing;

/**
 * Where a Receiver's `/active` endpoint differs from what a plan from `planConnection`
 * asks for; an empty list when it shows the change took effect.
 */
export function verifyConnection(plan: ConnectionPlan, active: object): string[];

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly analyseCapture: (a: number, b: number, c: number) => [number, number, number];
    readonly checkRegistry: (a: any) => [number, number, number];
    readonly decodePtp: (a: number, b: number) => [number, number, number];
    readonly lint: (a: number, b: number) => [number, number, number];
    readonly planConnection: (a: any) => [number, number, number];
    readonly routingMatrix: (a: any) => [number, number, number];
    readonly rules: () => [number, number, number];
    readonly timing: (a: number) => [number, number, number];
    readonly verifyConnection: (a: any, b: any) => [number, number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
