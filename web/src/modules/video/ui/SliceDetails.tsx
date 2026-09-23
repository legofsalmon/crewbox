import type { ReactNode } from 'react'
import {
  bboxOf,
  degrees,
  deviceLabel,
  fmt,
  type Rect,
  type ScreenView,
  type SliceView,
} from '../model/screenSetup.ts'
import styles from './ScreensView.module.scss'

/**
 * Everything the file says about one slice, in the words a screens tech
 * uses: where it takes its pixels from, where they land, whether that is
 * 1:1, and what the checks found.
 */
export default function SliceDetails({
  slice,
  screen,
  pinned,
}: {
  slice: SliceView
  screen: ScreenView
  pinned: boolean
}) {
  const { layer } = slice
  const rectText = (r: Rect | null, poly: SliceView['inPoly'], outside: boolean, what: string) => {
    if (!r || !poly) return <span className={styles.muted}>–</span>
    const bb = bboxOf(poly)
    return (
      <>
        {fmt(bb.x)}, {fmt(bb.y)} &nbsp;·&nbsp; {fmt(r.w)} × {fmt(r.h)}
        {r.rot ? <> &nbsp;·&nbsp; rotated {degrees(r.rot)}°</> : null}
        {outside && <span className={`${styles.chip} ${styles.warn}`}>outside {what}</span>}
      </>
    )
  }

  const flags: string[] = []
  if (layer.softEdge) flags.push('soft edge')
  if (layer.flip)
    flags.push(`flip ${{ 1: 'horizontal', 2: 'vertical', 3: 'both' }[layer.flip] ?? layer.flip}`)
  if (layer.isKey) flags.push('key')
  if (layer.blackBg) flags.push('black background')
  if (!layer.inputOpacity) flags.push('ignores input opacity')
  if (!layer.inputBypass) flags.push('ignores bypass/solo')

  const rows: [string, ReactNode][] = [
    ['Type', `${layer.kind}${layer.kind === 'Mask' && layer.invert ? ' (inverted)' : ''}`],
    [
      'Screen',
      <>
        {screen.screen.name}
        {!screen.screen.enabled && (
          <span className={`${styles.chip} ${styles.bad}`}>disabled</span>
        )}{' '}
        <span className={styles.muted}>{deviceLabel(screen.screen)}</span>
      </>,
    ],
    ['Enabled', layer.enabled ? 'Yes' : <span className={`${styles.chip} ${styles.bad}`}>No</span>],
  ]
  if (layer.kind !== 'Mask') {
    rows.push([
      'Source',
      <>
        {layer.source.label} <span className={styles.muted}>({layer.source.raw})</span>
      </>,
    ])
    rows.push(['Input', rectText(layer.input, slice.inPoly, slice.inOutside, 'composition')])
  }
  rows.push(['Output', rectText(layer.output, slice.outPoly, slice.outOutside, 'screen')])
  if (slice.scale) {
    rows.push([
      'Scale',
      <>
        ×{fmt(Math.round(slice.scale.sx * 1000) / 1000)} horizontal, ×
        {fmt(Math.round(slice.scale.sy * 1000) / 1000)} vertical{' '}
        <span className={`${styles.chip} ${slice.scale.tag === '1:1' ? styles.ok : styles.warn}`}>
          {slice.scale.tag}
        </span>
      </>,
    ])
  }
  if (layer.warpSummary) {
    rows.push([
      'Warp',
      <>
        {layer.warpSummary}
        {layer.cornerPinEdited && (
          <span className={`${styles.chip} ${styles.accent}`}>corner pin edited</span>
        )}
      </>,
    ])
  }
  if (layer.contour) {
    rows.push([
      'Shape',
      `${layer.contour.points.length} points${layer.contour.segments ? ` · segments ${layer.contour.segments}` : ''}${layer.contour.closed ? '' : ' · open'}`,
    ])
  }
  if (flags.length) rows.push(['Options', flags.join(' · ')])
  if (layer.kind === 'Slice') {
    rows.push([
      'Checks',
      slice.checks.length === 0 ? (
        <span className={`${styles.chip} ${styles.ok}`}>no issues</span>
      ) : (
        <>
          {slice.checks.map((c, i) => (
            <div key={i}>
              <span className={`${styles.chip} ${c.kind === 'gap' ? styles.bad : styles.warn}`}>
                {c.kind === 'subpx' ? 'sub-px' : c.kind}
              </span>{' '}
              {c.text}
            </div>
          ))}
        </>
      ),
    ])
  }

  return (
    <div className={styles.details} role="region" aria-label={`Slice ${layer.name}`}>
      <h3 className={styles.detailsTitle}>
        <span className={styles.swatch} style={{ background: slice.color }} />
        {layer.name}
        {pinned && <span className={styles.chip}>pinned</span>}
      </h3>
      <table className={styles.detailsTable}>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td>{k}</td>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
