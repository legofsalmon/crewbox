import type { CaptureReport } from '@crewbox/st2110'
import type { St2110 } from './st2110.ts'

/**
 * What passes between the page and the capture analyser's worker
 * (st2110Capture.worker.ts, started by `checkCapture` in st2110.ts), and the
 * worker's whole job, kept apart from the worker so it can be tested
 * without one.
 */

/** An SDP file to check the flows against, by name, as the analyser takes them. */
export interface CaptureSdp {
  name: string
  text: string
}

export interface CaptureRequest {
  /** The capture itself: a handle, so the page never holds its bytes. */
  file: Blob
  sdp: CaptureSdp[]
}

/**
 * Never a throw: which step failed is what decides the words the page uses
 * (loading the checks, reading the file, or the analysis itself).
 */
export type CaptureReply =
  | { ok: true; report: CaptureReport }
  | { ok: false; stage: 'load' | 'read' | 'analyse'; message: string }

const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : typeof err === 'string' ? err : String(err)

/** Load the checks, read the file, analyse it: one reply, whatever happens. */
export async function runCapture(
  load: () => Promise<Pick<St2110, 'analyseCapture'>>,
  request: CaptureRequest
): Promise<CaptureReply> {
  let checks: Pick<St2110, 'analyseCapture'>
  try {
    checks = await load()
  } catch (err) {
    return { ok: false, stage: 'load', message: messageOf(err) }
  }
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await request.file.arrayBuffer())
  } catch (err) {
    return { ok: false, stage: 'read', message: messageOf(err) }
  }
  try {
    return { ok: true, report: checks.analyseCapture(bytes, { sdp: request.sdp }) }
  } catch (err) {
    return { ok: false, stage: 'analyse', message: messageOf(err) }
  }
}
