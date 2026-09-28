import init, { analyseCapture } from '@crewbox/st2110'
import wasmUrl from '@crewbox/st2110/st2110_wasm_bg.wasm?url'
import { runCapture, type CaptureRequest } from './st2110Capture.ts'

/**
 * The capture analyser's own thread: one capture in, one reply out, and then
 * the page terminates it (`checkCapture` in st2110.ts says why). The file
 * arrives as a handle and is read here, so its bytes are only ever in this
 * worker's memory.
 */

const load = async () => {
  await init({ module_or_path: wasmUrl })
  return { analyseCapture }
}

self.onmessage = async ({ data }: MessageEvent<CaptureRequest>) => {
  self.postMessage(await runCapture(load, data))
}
