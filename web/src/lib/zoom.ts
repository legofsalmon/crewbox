/**
 * Pure pan/zoom math for the image viewer. Coordinates live in the image's
 * base (unscaled) box: the transform is translate(tx,ty) scale(s) with
 * origin 0 0, so a base-box point q appears on screen at t + s·q.
 */

export interface ZoomState {
  scale: number
  tx: number
  ty: number
}

export const ZOOM_MIN = 1
export const ZOOM_MAX = 5
/** Double-tap zooms to this. */
export const ZOOM_TAP = 2.5

export const zoomIdentity: ZoomState = { scale: 1, tx: 0, ty: 0 }

/** Keep the scaled image covering the box — no gaps at any edge. */
function clampPan(scale: number, tx: number, ty: number, w: number, h: number): ZoomState {
  return {
    scale,
    tx: Math.min(0, Math.max(w - w * scale, tx)),
    ty: Math.min(0, Math.max(h - h * scale, ty)),
  }
}

/**
 * Zoom by `factor` keeping the base-box point under (focalX, focalY) fixed
 * on screen. Scale clamps to [ZOOM_MIN, ZOOM_MAX]; at 1 the pan resets.
 */
export function zoomAt(
  state: ZoomState,
  focalX: number,
  focalY: number,
  factor: number,
  w: number,
  h: number
): ZoomState {
  const scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, state.scale * factor))
  const k = scale / state.scale
  return clampPan(scale, focalX - k * (focalX - state.tx), focalY - k * (focalY - state.ty), w, h)
}

/** Pan by a screen-space delta, clamped to the image edges. */
export function panBy(state: ZoomState, dx: number, dy: number, w: number, h: number): ZoomState {
  return clampPan(state.scale, state.tx + dx, state.ty + dy, w, h)
}
