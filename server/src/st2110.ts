import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as module from '@crewbox/st2110'
import { seaAsset } from './box.ts'

/**
 * The ST 2110 checks, written in Rust in legofsalmon/st2110 and carried here
 * as WebAssembly (st2110/README.md): the SDP linter, the ST 2059-2 PTP
 * message checks and the NMOS registry checks.
 *
 * Loaded once, the first time something asks, which on a box that is not
 * watching a media network is never. Inside the box binary the module is an
 * embedded asset (scripts/build-box.mjs); under plain Node it is the file in
 * the workspace. It compiles asynchronously, so the megabyte of it never
 * holds up the event loop the chat and the voice server share.
 *
 * A module that will not load is a line on the panel, not a crash — the same
 * contract as a watcher that cannot open its port. `loadSt2110()` resolves to
 * null and `st2110Error()` says why; everything that uses the checks treats
 * null as "not checked", never as "fine".
 */

/** What the box uses. The rest (capture analysis, IS-05 planning) is the browser's. */
export type St2110 = Pick<typeof module, 'lint' | 'decodePtp' | 'checkRegistry'>

/** The key scripts/build-box.mjs embeds the module under. */
export const ST2110_ASSET = 'st2110/st2110_wasm_bg.wasm'

let loading: Promise<St2110 | null> | null = null
let loaded: St2110 | null = null
let failure: string | null = null

/** The module's bytes: the box binary's copy, or the workspace file. */
function moduleBytes(): Uint8Array {
  const embedded = seaAsset(ST2110_ASSET)
  if (embedded) return new Uint8Array(embedded)
  const require = createRequire(import.meta.url)
  return readFileSync(require.resolve('@crewbox/st2110/st2110_wasm_bg.wasm'))
}

/** Load the checks, once. Never rejects. */
export function loadSt2110(): Promise<St2110 | null> {
  loading ??= (async () => {
    try {
      await module.default({ module_or_path: moduleBytes() })
      loaded = module
      return loaded
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err)
      return null
    }
  })()
  return loading
}

/**
 * The checks if they have loaded, else null — for code on a packet path,
 * which must not wait. It starts the load, so the next packet finds them.
 */
export function st2110(): St2110 | null {
  if (!loaded && !loading) void loadSt2110()
  return loaded
}

/** Why the checks are unavailable, once a load has failed. */
export function st2110Error(): string | null {
  return failure
}
