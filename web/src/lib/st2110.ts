import type * as St2110Module from '@crewbox/st2110'
// A URL, not the bytes: nothing is fetched until a tool asks for the checks.
import wasmUrl from '@crewbox/st2110/st2110_wasm_bg.wasm?url'
import type { CaptureReply, CaptureRequest, CaptureSdp } from './st2110Capture.ts'

/**
 * The ST 2110 checks in the browser (st2110/README.md): the SDP linter and
 * the capture analyser, run on this device.
 *
 * About a megabyte, so it is fetched the first time somebody uses a tool
 * that needs it and never otherwise — the same rule the voice chunk keeps,
 * for the same reason: every crew phone joins over the same festival Wi-Fi.
 * The service worker keeps it once fetched (vite.config.ts), so the tools
 * work offline afterwards.
 */

export type St2110 = typeof St2110Module

let loading: Promise<St2110> | null = null

/** The checks, loaded once. A failed load is forgotten, so a retry can work. */
export function loadSt2110(): Promise<St2110> {
  loading ??= (async () => {
    const module = await import('@crewbox/st2110')
    await module.default({ module_or_path: wasmUrl })
    return module
  })().catch((err: unknown) => {
    loading = null
    throw err
  })
  return loading
}

/**
 * Analyse a capture in a worker of its own, which is thrown away afterwards.
 *
 * Not the page's copy of the checks, which the SDP linter uses, and the
 * reason is size. The analyser takes the whole file at once, and a
 * WebAssembly instance's memory only ever grows: a gigabyte capture checked
 * in the page would leave the page holding a gigabyte until it was reloaded,
 * on a laptop that has crewbox open all day. A worker's memory goes when the
 * worker does. And a big capture takes seconds; in a worker, the page keeps
 * answering while it is read.
 *
 * Resolves to the worker's reply, including when it could not start; rejects
 * only when `signal` stops it, with the signal's reason.
 */
export function checkCapture(
  file: Blob,
  sdp: CaptureSdp[],
  signal?: AbortSignal
): Promise<CaptureReply> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const worker = new Worker(new URL('./st2110Capture.worker.ts', import.meta.url), {
      type: 'module',
    })
    const finish = () => {
      worker.terminate()
      signal?.removeEventListener('abort', stop)
    }
    const stop = () => {
      finish()
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', stop, { once: true })
    worker.onmessage = (event: MessageEvent<CaptureReply>) => {
      finish()
      resolve(event.data)
    }
    // The worker's script would not load: offline before the page ever
    // fetched it, most likely. The same words as checks that would not load.
    worker.onerror = (event) => {
      event.preventDefault()
      finish()
      resolve({ ok: false, stage: 'load', message: event.message || 'the analyser did not start' })
    }
    worker.onmessageerror = () => {
      finish()
      resolve({ ok: false, stage: 'analyse', message: 'the report did not come back whole' })
    }
    const request: CaptureRequest = { file, sdp }
    worker.postMessage(request)
  })
}
