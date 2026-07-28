/**
 * Keep --app-height pinned to the *visible* viewport height.
 *
 * iOS Safari (especially installed/standalone) does not shrink the layout
 * viewport when the keyboard opens, and its scroll restore after an input
 * focus is unreliable — which left the app stuck scrolled with the top bar
 * off-screen. Combined with `body { position: fixed }`, driving height from
 * visualViewport means the app always fills exactly what the user can see,
 * and the composer stays above the keyboard.
 */
function applyViewportHeight(): void {
  const height = window.visualViewport?.height ?? window.innerHeight
  // A 0/invalid reading (seen transiently during load) is a *valid* CSS value
  // that would override the 100dvh fallback and collapse the app — never set it.
  if (height > 0) {
    document.documentElement.style.setProperty('--app-height', `${Math.round(height)}px`)
  }
  // Belt and braces: undo any residual document scroll iOS may have left.
  if (window.scrollY !== 0) window.scrollTo(0, 0)
}

applyViewportHeight()
// Re-measure after layout settles, in case the first read was 0.
requestAnimationFrame(applyViewportHeight)
window.addEventListener('load', applyViewportHeight)

const vv = window.visualViewport
vv?.addEventListener('resize', applyViewportHeight)
vv?.addEventListener('scroll', applyViewportHeight)
window.addEventListener('resize', applyViewportHeight)
window.addEventListener('orientationchange', () => {
  // The new dimensions settle a beat after the rotation event.
  setTimeout(applyViewportHeight, 100)
})

/**
 * Stop Safari zooming the interface.
 *
 * `user-scalable=no` in the viewport meta has been ignored by iOS Safari
 * since iOS 10, and `touch-action: manipulation` (see body in app.css) does
 * not cover Safari's own pinch gesture either. These three non-standard
 * events are the only thing that does.
 *
 * This is not a general "no zoom" policy: the image viewer implements pinch
 * itself with pointer events, so photos and plans still zoom. What it stops
 * is zooming the *chrome*, which on a position:fixed app that cannot scroll
 * leaves crew looking at a magnified corner with no way back.
 */
const blockBrowserZoom = (event: Event): void => event.preventDefault()
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, blockBrowserZoom, { passive: false })
}
