import type * as St2110Module from '@crewbox/st2110'
// A URL, not the bytes: nothing is fetched until a tool asks for the checks.
import wasmUrl from '@crewbox/st2110/st2110_wasm_bg.wasm?url'

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
