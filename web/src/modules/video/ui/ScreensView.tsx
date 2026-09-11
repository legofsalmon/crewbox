import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ProcessorStatus } from '@crewbox/shared'
import DrawerButton from '../../../shell/DrawerButton.tsx'
import { useStore } from '../../../store.ts'
import { useDocMissing } from '../../../lib/docs/hooks.ts'
import { deliverFile, deliveredNote } from '../../../lib/download.ts'
import { fetchVideoState } from '../model/api.ts'
import { feedStatus } from '../model/feeds.ts'
import { ago } from '../model/format.ts'
import {
  bboxOf,
  buildView,
  degrees,
  deviceLabel,
  fmt,
  meshLines,
  parseScreenSetup,
  type ScreenView,
  type SliceView,
} from '../model/screenSetup.ts'
import { replaceSetup, setFeed } from '../model/screensDoc.ts'
import { deleteScreens, markScreensSeen, useScreensDoc } from '../store/screensStore.ts'
import ScreenMap, { type MapItem } from './ScreenMap.tsx'
import SliceDetails from './SliceDetails.tsx'
import { renderTestCard, type CardItem } from './testCard.ts'
import styles from './ScreensView.module.scss'

/**
 * One screen map: the composition with every slice's input drawn on it, then
 * a map per screen of where those slices land, with the crew's note of which
 * processor input feeds that screen.
 *
 * That last part is what earns the pane its place in the Video module. The
 * box already reads whether a processor's inputs carry signal; this is the
 * other half — which content is on that input — so "no signal on HDMI 1"
 * can be said as "Upstage is dark, that's the Upstage and Full slices".
 *
 * Read-only towards Resolume, like everything else in this module: the map
 * is a copy of a file. Changing it here changes nothing on the outputs.
 */

const POLL_MS = 10_000
const WATCH_MS = 1_000

const fmtI = (n: number) => String(Math.round(n))
const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'screen map'
const byAreaDesc = (a: MapItem, b: MapItem) => {
  const A = bboxOf(a.poly)
  const B = bboxOf(b.poly)
  return B.w * B.h - A.w * A.h
}

const subFor = (s: SliceView, kind: 'input' | 'output'): string => {
  const poly = kind === 'input' ? s.inPoly : s.outPoly
  const r = kind === 'input' ? s.layer.input : s.layer.output
  if (!poly) return ''
  const bb = bboxOf(poly)
  if (kind === 'output' && s.layer.kind === 'Mask') {
    return `mask · ${s.layer.contour?.points.length ?? 0} pts`
  }
  const w = r ? r.w : bb.w
  const h = r ? r.h : bb.h
  const rot = r?.rot ? ` · ${Math.round(degrees(r.rot))}°` : ''
  return `${fmtI(bb.x)}, ${fmtI(bb.y)} · ${fmtI(w)}×${fmtI(h)}${rot}`
}

/** File System Access API — Chrome and Edge; the others simply don't get the button. */
interface FileHandle {
  name: string
  getFile: () => Promise<File>
}
type Picker = (options: unknown) => Promise<FileHandle[]>
const filePicker = (): Picker | null =>
  typeof window === 'undefined'
    ? null
    : ((window as unknown as { showOpenFilePicker?: Picker }).showOpenFilePicker ?? null)

const Chip = ({
  tone,
  children,
  title,
}: {
  tone?: 'ok' | 'warn' | 'bad' | 'accent'
  children: ReactNode
  title?: string
}) => (
  <span className={`${styles.chip} ${tone ? styles[tone] : ''}`} title={title}>
    {children}
  </span>
)

const checkChips = (s: SliceView) =>
  [...new Set(s.checks.map((c) => c.kind))].map((k) =>
    k === 'gap' ? (
      <Chip key={k} tone="bad" title="Gap to a neighbouring slice">
        gap
      </Chip>
    ) : k === 'overlap' ? (
      <Chip key={k} tone="warn" title="Overlaps another slice on this screen">
        overlap
      </Chip>
    ) : (
      <Chip key={k} tone="warn" title="Not on whole pixels">
        sub-px
      </Chip>
    )
  )

export default function ScreensView({ id, onClose }: { id: string; onClose: () => void }) {
  const me = useStore((s) => s.me)
  const by = me?.name ?? ''
  const { doc, snapshot, loaded } = useScreensDoc(id)
  const missing = useDocMissing(doc, loaded)
  const setup = snapshot?.setup ?? null
  const view = useMemo(() => (setup ? buildView(setup) : null), [setup])

  const [hoverId, setHoverId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [processors, setProcessors] = useState<ProcessorStatus[]>([])
  const [note, setNote] = useState('')
  const [watching, setWatching] = useState<{ name: string; updatedAt: string } | null>(null)
  const watchRef = useRef<{
    handle: FileHandle
    timer: number
    last: number | null
    retry: boolean
    busy: boolean
  } | null>(null)
  const updateRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    markScreensSeen(id)
    return () => markScreensSeen(id)
  }, [id])

  // Same shape as the LED pane's poll: paused while the tab is hidden, and a
  // box that does not answer is the offline default, not an error to show.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const state = await fetchVideoState()
        if (!cancelled) setProcessors(state.processors)
      } catch {
        // keep whatever we had
      }
    }
    void load()
    const timer = window.setInterval(() => {
      if (!document.hidden) void load()
    }, POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  const stopWatch = useCallback(() => {
    const w = watchRef.current
    if (w) window.clearInterval(w.timer)
    watchRef.current = null
    setWatching(null)
  }, [])
  useEffect(() => stopWatch, [stopWatch])

  const applyFile = useCallback(
    (file: File, text: string) => {
      if (!doc) return false
      replaceSetup(doc, parseScreenSetup(text, file.name), { sourceFile: file.name, by })
      return true
    },
    [doc, by]
  )

  const pollWatch = useCallback(
    async (first: boolean) => {
      const w = watchRef.current
      if (!w || w.busy) return
      w.busy = true
      try {
        const file = await w.handle.getFile()
        if (file.lastModified !== w.last || w.retry) {
          const text = await file.text()
          try {
            // A read that lands mid-write fails to parse: keep the map we
            // have and try again on the next tick.
            applyFile(file, text)
            w.retry = false
            setWatching({ name: w.handle.name, updatedAt: new Date().toLocaleTimeString() })
            setNote('')
          } catch (err) {
            w.retry = true
            if (first) {
              setNote(
                `Could not read ${file.name}: ${err instanceof Error ? err.message : 'unreadable file'}`
              )
              stopWatch()
            }
          }
          w.last = file.lastModified
        }
      } catch (err) {
        setNote(`Stopped watching: ${err instanceof Error ? err.message : 'the file went away'}`)
        stopWatch()
      } finally {
        w.busy = false
      }
    },
    [applyFile, stopWatch]
  )

  const startWatch = async () => {
    const picker = filePicker()
    if (!picker) return
    let handle: FileHandle | undefined
    try {
      const picked = await picker({
        multiple: false,
        startIn: 'documents',
        types: [
          {
            description: 'Resolume Advanced Output XML',
            accept: { 'text/xml': ['.xml'], 'application/xml': ['.xml'] },
          },
        ],
      })
      handle = picked[0]
    } catch (err) {
      if (!(err instanceof Error && err.name === 'AbortError')) {
        setNote(`Could not open the file: ${err instanceof Error ? err.message : ''}`)
      }
      return
    }
    if (!handle) return
    stopWatch()
    watchRef.current = { handle, timer: 0, last: null, retry: false, busy: false }
    await pollWatch(true)
    const w = watchRef.current
    if (w) {
      w.timer = window.setInterval(() => void pollWatch(false), WATCH_MS)
      setWatching({ name: handle.name, updatedAt: new Date().toLocaleTimeString() })
    }
  }

  const updateFrom = async (file: File | undefined) => {
    if (!file) return
    stopWatch()
    try {
      applyFile(file, await file.text())
      setNote(`Updated from ${file.name}`)
    } catch (err) {
      setNote(
        `Could not read ${file.name}: ${err instanceof Error ? err.message : 'unreadable file'}`
      )
    }
  }

  const inputItems = useMemo<MapItem[]>(() => {
    if (!view) return []
    const out: MapItem[] = []
    for (const sc of view.screens) {
      for (const s of sc.slices) {
        if (!s.inPoly) continue
        out.push({
          id: s.id,
          poly: s.inPoly,
          name: s.layer.name + (s.active ? '' : ' (off)'),
          sub: subFor(s, 'input'),
          color: s.color,
          hue: s.hue,
          active: s.active,
          mask: false,
        })
      }
    }
    return out.sort(byAreaDesc)
  }, [view])

  const outputItems = useMemo(() => {
    const m = new Map<string, MapItem[]>()
    if (!view) return m
    for (const sc of view.screens) {
      const items: MapItem[] = []
      for (const s of sc.slices) {
        if (!s.outPoly) continue
        items.push({
          id: s.id,
          poly: s.outPoly,
          name: s.layer.name + (s.active ? '' : ' (off)'),
          sub: subFor(s, 'output'),
          color: s.color,
          hue: s.hue,
          active: s.active,
          mask: s.layer.kind === 'Mask',
        })
      }
      m.set(sc.id, items.sort(byAreaDesc))
    }
    return m
  }, [view])

  const feedOptions = useMemo(
    () =>
      processors.flatMap((p) => {
        const name = p.processor.name || p.processor.host
        const inputs = p.reading?.inputs ?? []
        if (inputs.length === 0) return [{ value: `${p.processor.id}|`, label: name }]
        return inputs.map((i) => ({
          value: `${p.processor.id}|${i.id}`,
          label: `${name} · ${i.name ?? i.id}${i.connector ? ` (${i.connector})` : ''}`,
        }))
      }),
    [processors]
  )

  const exportPng = async (kind: 'input' | 'output', sc?: ScreenView) => {
    if (!view || !snapshot) return
    const items = kind === 'input' ? inputItems : (outputItems.get(sc?.id ?? '') ?? [])
    const bounds = kind === 'input' ? view.comp : sc!.bounds
    const cards: CardItem[] = items.map((it) => ({
      poly: it.poly,
      name: it.name,
      sub: it.sub.replace(' · ', ' // ').replace('×', ' x '),
      hue: it.hue,
    }))
    const title =
      kind === 'input' ? snapshot.meta.title : `${snapshot.meta.title} · ${sc!.screen.name}`
    const canvas = renderTestCard({ bounds, items: cards, title })
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) {
      setNote('Could not render the PNG')
      return
    }
    const file = `${safeName(snapshot.meta.title)} - ${kind === 'input' ? 'input map' : safeName(sc!.screen.name)}.png`
    setNote(deliveredNote(await deliverFile(file, blob), 'PNG'))
  }

  const remove = () => {
    if (!snapshot) return
    if (window.confirm(`Delete “${snapshot.meta.title}” from this device and the shared index?`)) {
      void deleteScreens(id)
      onClose()
    }
  }

  if (missing) {
    return (
      <div className={styles.pane}>
        <header className={styles.header}>
          <DrawerButton />
          <h1 className={styles.title}>Screen map</h1>
        </header>
        <p className={styles.note}>
          This screen map is not on this box, or has been deleted.{' '}
          <button type="button" className={styles.linkButton} onClick={onClose}>
            All screen maps
          </button>
        </p>
      </div>
    )
  }
  if (!snapshot || !setup || !view) {
    return (
      <div className={styles.pane}>
        <header className={styles.header}>
          <DrawerButton />
          <h1 className={styles.title}>{snapshot?.meta.title || 'Screen map'}</h1>
        </header>
        <p className={styles.note}>Opening…</p>
      </div>
    )
  }

  const { meta } = snapshot
  const { stats } = view
  const now = Date.now()
  const currentId = hoverId ?? selectedId
  const current = currentId ? (view.byId.get(currentId) ?? null) : null

  return (
    <div className={styles.pane}>
      <header className={styles.header}>
        <DrawerButton />
        <h1 className={styles.title}>{meta.title}</h1>
        <div className={styles.toolbar}>
          <button
            type="button"
            className={styles.tool}
            onClick={() => updateRef.current?.click()}
            title="Replace this map with a newer save of the preset"
          >
            Update from XML…
          </button>
          <input
            ref={updateRef}
            type="file"
            accept=".xml,text/xml,application/xml"
            className={styles.hiddenFile}
            aria-label="Update from Advanced Output XML"
            onChange={(e) => {
              void updateFrom(e.target.files?.[0])
              e.target.value = ''
            }}
          />
          {filePicker() &&
            (watching ? (
              <button type="button" className={styles.tool} onClick={stopWatch}>
                Stop watching
              </button>
            ) : (
              <button
                type="button"
                className={styles.tool}
                onClick={() => void startWatch()}
                title="Re-read the file whenever Resolume saves it (Chrome / Edge on the Resolume machine)"
              >
                Watch file…
              </button>
            ))}
          <button type="button" className={styles.tool} onClick={() => void exportPng('input')}>
            Export PNG
          </button>
          <button type="button" className={styles.tool} onClick={onClose}>
            All maps
          </button>
          <button type="button" className={`${styles.tool} ${styles.danger}`} onClick={remove}>
            Delete
          </button>
        </div>
      </header>

      <div className={styles.body}>
        <p className={styles.meta}>
          {setup.version} · {setup.format === 'preferences' ? 'live setup file' : 'saved preset'} ·
          imported by {meta.importedBy || 'someone'} {ago(Date.parse(meta.importedAt) || null, now)}
          {meta.updatedAt && meta.updatedAt !== meta.importedAt && (
            <>
              {' '}
              · updated by {meta.updatedBy || 'someone'}{' '}
              {ago(Date.parse(meta.updatedAt) || null, now)}
            </>
          )}
          {meta.sourceFile && <> · {meta.sourceFile}</>}
        </p>
        {watching && (
          <p className={styles.watching} role="status">
            <span className={styles.dot} /> watching {watching.name} · {watching.updatedAt}
          </p>
        )}
        {note && (
          <p className={styles.note} role="status">
            {note}
          </p>
        )}

        <p className={styles.summary}>
          Composition{' '}
          <b>
            {fmt(view.comp.w)} × {fmt(view.comp.h)}
          </b>{' '}
          · {stats.screens} screen
          {stats.screens === 1 ? '' : 's'} · {stats.slices} slice{stats.slices === 1 ? '' : 's'}
          {stats.masks > 0 && (
            <>
              {' '}
              · {stats.masks} mask{stats.masks === 1 ? '' : 's'}
            </>
          )}
          {stats.disabled > 0 && <> · {stats.disabled} disabled</>}
          {stats.outside > 0 && (
            <Chip tone="warn" title="Enabled slices outside the composition or their screen">
              {stats.outside} outside bounds
            </Chip>
          )}
          {stats.scaled > 0 && (
            <Chip tone="warn" title="Enabled slices whose output size differs from their input">
              {stats.scaled} scaled
            </Chip>
          )}
          {stats.warped > 0 && <Chip tone="accent">{stats.warped} warped</Chip>}
          {stats.subpx > 0 && (
            <Chip tone="warn" title="Not on whole pixels — resamples softly on LED">
              {stats.subpx} sub-pixel
            </Chip>
          )}
          {stats.overlaps > 0 && (
            <Chip tone="warn" title="Enabled slices whose outputs overlap on one screen">
              {stats.overlaps} overlapping
            </Chip>
          )}
          {stats.gaps > 0 && (
            <Chip tone="bad" title="Enabled slices with a gap of 8 px or less to a neighbour">
              {stats.gaps} with gaps
            </Chip>
          )}
          {view.compDerived && <Chip tone="warn">composition size derived from slices</Chip>}
        </p>

        <section className={styles.card} aria-label="Input map">
          <h2 className={styles.cardTitle}>
            Input · Composition{' '}
            <span className={styles.cardMeta}>
              {fmt(view.comp.w)} × {fmt(view.comp.h)} px · {inputItems.length} items
            </span>
          </h2>
          <div className={styles.inputMap}>
            <ScreenMap
              bounds={view.comp}
              items={inputItems}
              hoverId={hoverId}
              selectedId={selectedId}
              onHover={setHoverId}
              onSelect={setSelectedId}
              label={`Input map of the ${fmt(view.comp.w)} by ${fmt(view.comp.h)} composition`}
            />
          </div>
        </section>

        <div className={styles.screens}>
          {view.screens.map((sc) => {
            const feed = snapshot.feeds[sc.screen.name]
            const value = feed ? `${feed.processorId}|${feed.inputId}` : ''
            const options =
              value && !feedOptions.some((o) => o.value === value)
                ? [
                    ...feedOptions,
                    { value, label: `${feed!.processorId} · ${feed!.inputId} (not listed now)` },
                  ]
                : feedOptions
            const status = feedStatus(feed, processors)
            const affected = sc.slices
              .filter((s) => s.active && s.layer.kind === 'Slice')
              .map((s) => s.layer.name)
            const mesh =
              current && current.screenIndex === sc.index && current.layer.warp
                ? meshLines(current.layer.warp)
                : null
            return (
              <section key={sc.id} className={styles.card} aria-label={`Screen ${sc.screen.name}`}>
                <h2 className={styles.cardTitle}>
                  <span
                    className={styles.swatch}
                    style={{ background: `hsl(${sc.hue} 85% 55%)` }}
                  />
                  {sc.screen.name}
                  <span className={styles.cardMeta}>
                    {deviceLabel(sc.screen)}
                    {sc.boundsDerived ? ' · bounds from slices' : ''}
                  </span>
                  {!sc.screen.enabled && <Chip tone="bad">disabled</Chip>}
                  {sc.screen.hidden && <Chip>hidden</Chip>}
                  <button
                    type="button"
                    className={styles.smallTool}
                    onClick={() => void exportPng('output', sc)}
                  >
                    PNG
                  </button>
                </h2>
                <div className={styles.feedRow}>
                  <label className={styles.feedLabel}>
                    <span>Fed by</span>
                    <select
                      className={styles.feedSelect}
                      aria-label={`Processor input feeding ${sc.screen.name}`}
                      value={value}
                      onChange={(e) => {
                        if (!doc) return
                        const v = e.target.value
                        if (!v) {
                          setFeed(doc, sc.screen.name, null)
                          return
                        }
                        const [processorId = '', inputId = ''] = v.split('|')
                        setFeed(doc, sc.screen.name, { processorId, inputId })
                      }}
                    >
                      <option value="">
                        {processors.length === 0 ? 'no processors listed' : 'not mapped'}
                      </option>
                      {options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {status && (
                    <span
                      className={`${styles.chip} ${
                        status.tone === 'ok'
                          ? styles.ok
                          : status.tone === 'fault'
                            ? styles.bad
                            : status.tone === 'warn'
                              ? styles.warn
                              : ''
                      }`}
                      role={status.tone === 'fault' ? 'alert' : undefined}
                    >
                      {status.text}
                    </span>
                  )}
                  {status?.tone === 'fault' && affected.length > 0 && (
                    <span className={styles.affected}>dark: {affected.join(', ')}</span>
                  )}
                </div>
                <div className={styles.outputMap}>
                  <ScreenMap
                    bounds={sc.bounds}
                    items={outputItems.get(sc.id) ?? []}
                    hoverId={hoverId}
                    selectedId={selectedId}
                    onHover={setHoverId}
                    onSelect={setSelectedId}
                    mesh={mesh}
                    label={`Output map of screen ${sc.screen.name}`}
                  />
                </div>
                <ul className={styles.slices}>
                  {sc.slices.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        className={[
                          styles.sliceRow,
                          s.id === selectedId ? styles.rowSelected : '',
                          s.id === hoverId ? styles.rowHover : '',
                          s.active ? '' : styles.rowOff,
                        ].join(' ')}
                        onClick={() => setSelectedId(s.id === selectedId ? null : s.id)}
                        onPointerEnter={() => setHoverId(s.id)}
                        onPointerLeave={() => setHoverId(null)}
                      >
                        <span className={styles.swatch} style={{ background: s.color }} />
                        <span className={styles.sliceName}>{s.layer.name}</span>
                        {s.layer.kind !== 'Slice' && (
                          <Chip tone="accent">{s.layer.kind.toLowerCase()}</Chip>
                        )}
                        {s.layer.kind !== 'Mask' && s.layer.source.kind !== 'composition' && (
                          <Chip tone="accent">{s.layer.source.label}</Chip>
                        )}
                        {(s.inOutside || s.outOutside) && (
                          <Chip tone="warn" title="Outside the composition or screen bounds">
                            outside
                          </Chip>
                        )}
                        {s.scale && s.scale.tag !== '1:1' && (
                          <Chip tone="warn" title="Output size differs from input size">
                            {s.scale.tag}
                          </Chip>
                        )}
                        {checkChips(s)}
                        <span className={styles.dim}>
                          {s.layer.output
                            ? `${fmt(s.layer.output.w)}×${fmt(s.layer.output.h)}`
                            : ''}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}
        </div>
      </div>

      {current && (
        <div className={styles.detailsBar}>
          <SliceDetails
            slice={current}
            screen={view.screens[current.screenIndex]!}
            pinned={current.id === selectedId}
          />
        </div>
      )}
    </div>
  )
}
