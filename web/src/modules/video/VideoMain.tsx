import { useCallback, useEffect, useState } from 'react'
import type { VideoAction, VideoIntent } from '@crewbox/shared'
import DrawerButton from '../../shell/DrawerButton.tsx'
import { useStore } from '../../store.ts'
import {
  addProcessor,
  fetchVideoState,
  raiseIntent,
  removeProcessor,
  runScan,
  setWatching,
  type VideoState,
} from './model/api.ts'
import { byUrgency } from './model/format.ts'
import ConfirmTransmit from './ui/ConfirmTransmit.tsx'
import ProcessorRow from './ui/ProcessorRow.tsx'
import ScreensSelector from './ui/ScreensSelector.tsx'
import ScreensView from './ui/ScreensView.tsx'
import styles from './VideoMain.module.scss'

/**
 * The module's main pane, routed by subpath: the LED walls at /m/video,
 * the screen-map selector at /m/video/screens, one map at
 * /m/video/screens/<id>. Navigation goes through the shell, so a map is
 * deep-linkable and a link to one posted in chat opens it.
 */
export default function VideoMain({ subpath }: { subpath: string }) {
  const setActiveModule = useStore((s) => s.setActiveModule)
  // `screens/new` before the prefix test below, and it is the sidebar's `+`:
  // two controls that went to the same place, one of them labelled "Import a
  // screen map" and unable to do it.
  if (subpath === 'screens' || subpath === 'screens/new') {
    return (
      <ScreensSelector
        startCreating={subpath === 'screens/new'}
        onOpen={(id) => setActiveModule('video', `screens/${id}`)}
      />
    )
  }
  if (subpath.startsWith('screens/')) {
    const id = subpath.slice('screens/'.length)
    // Keyed by map: switching maps from the sidebar is a different document,
    // and the pinned slice and hover belong to the one being left.
    return <ScreensView key={id} id={id} onClose={() => setActiveModule('video', 'screens')} />
  }
  return <LedWallsPane />
}

/**
 * Video → LED: what the walls are doing, from the other side of the site.
 *
 * The module reads and cannot write. Nothing crewbox sends can change what is
 * on a wall — there is no encoder in the codebase that could.
 *
 * So the pane is the crew's: anyone signed in can name a processor and watch
 * it, because everything that starts is an addressed GET. The sweep is the
 * exception and takes the admin password, being the one packet here that is
 * not a read of a named device — a broadcast at a whole segment.
 *
 * Watching still shows the confirmation, to everyone. Not as a permission
 * check, which the box does: as the screen where a crew member reads what is
 * about to go on a show network before it does.
 *
 * Polling, like the network audit, and paused when the tab is hidden. A pane
 * nobody has open costs nothing — but note that unlike the audit, the *box*
 * keeps polling armed processors regardless, because a wall that goes down
 * while everyone's phone is asleep is exactly the one worth having a record
 * of.
 */

const POLL_MS = 10_000

function LedWallsPane() {
  const adminToken = useStore((s) => s.adminToken)
  const [state, setState] = useState<VideoState | null>(null)
  const [error, setError] = useState('')
  const [host, setHost] = useState('')
  const [name, setName] = useState('')
  const [addError, setAddError] = useState('')
  const [pending, setPending] = useState<{ intent: VideoIntent } | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmError, setConfirmError] = useState('')

  const load = useCallback(async () => {
    try {
      setState(await fetchVideoState())
      setError('')
    } catch (err) {
      // Offline is the default, not an error state: keep whatever is on
      // screen and say the refresh is waiting.
      setError(err instanceof Error ? err.message : 'the box is not answering')
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => {
      if (!document.hidden) void load()
    }, POLL_MS)
    // The poll skips a hidden page, so a phone coming back from the lock
    // screen shows the walls as they were when it was locked. Ask the
    // moment somebody looks, as the network pane does.
    const onVisible = () => {
      if (!document.hidden) void load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [load])

  /** Half one: ask the box what this would send. Transmits nothing. */
  const propose = async (action: VideoAction, processorId?: string) => {
    setConfirmError('')
    try {
      const { intent } = await raiseIntent(action, processorId, adminToken ?? undefined)
      setPending({ intent })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not ask the box')
    }
  }

  /** Half two: the admin has read what it would send and said yes. */
  const confirm = async () => {
    if (!pending) return
    setBusy(true)
    setConfirmError('')
    try {
      if (pending.intent.action === 'scan') {
        // The unlock can lapse between raising the intent and confirming it
        // — reading what a sweep will send is exactly the pause where that
        // happens. Returning silently left the dialog open with the button
        // doing nothing, which reads as a broken box rather than a lock.
        if (!adminToken) {
          setConfirmError('The admin unlock has expired — unlock again and start over.')
          return
        }
        await runScan(adminToken, pending.intent.token)
      } else {
        await setWatching(pending.intent.processorId!, true, pending.intent.token)
      }
      setPending(null)
      await load()
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : 'the box refused')
    } finally {
      setBusy(false)
    }
  }

  const add = async (event: React.FormEvent) => {
    event.preventDefault()
    setAddError('')
    try {
      await addProcessor(host.trim(), name.trim())
      setHost('')
      setName('')
      await load()
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'could not add it')
    }
  }

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'the box refused')
    } finally {
      setBusy(false)
    }
  }

  const now = Date.now()
  const processors = state ? [...state.processors].sort(byUrgency) : []
  const watching = processors.filter((p) => p.processor.monitored).length

  return (
    <div className={styles.pane}>
      <header className={styles.header}>
        <DrawerButton />
        <h1 className={styles.title}>LED walls</h1>
        {state && (
          <span className={styles.count}>
            {watching === 0
              ? 'nothing being watched'
              : `watching ${watching} of ${processors.length}`}
          </span>
        )}
      </header>

      {/*
        Unconditional. It used to render only before the first successful
        load, so once the pane had state a failed Remove or Stop, or a
        refresh that had been failing for ten minutes, showed nothing at all
        — the row simply did not change and the crew member pressed it
        again. A pane about what the box can see has to say when it cannot
        see.
      */}
      {error && (
        <p className={styles.note} role="status">
          {state === null ? 'Waiting for the box: ' : 'The box did not answer: '}
          {error}
        </p>
      )}

      {state && (
        <div className={styles.body}>
          <p className={styles.blurb}>
            crewbox reads LED processors and cannot control them. There is no way from here to
            change brightness, recall a preset or black out a screen — the code to do it does not
            exist in the box.
          </p>

          {processors.length === 0 ? (
            <p className={styles.empty}>
              No processors yet. Add one by address below, or — if you know which network they are
              on — sweep for them.
            </p>
          ) : (
            <ul className={styles.list}>
              {processors.map((status) => (
                <ProcessorRow
                  key={status.processor.id}
                  status={status}
                  now={now}
                  busy={busy}
                  onWatch={() => void propose('watch', status.processor.id)}
                  onStop={() => void act(() => setWatching(status.processor.id, false))}
                  onRemove={() => void act(() => removeProcessor(status.processor.id))}
                />
              ))}
            </ul>
          )}

          <section className={styles.admin} aria-label="Add a processor">
            <h2 className={styles.sectionTitle}>Add a processor</h2>
            <p className={styles.sectionBlurb}>
              Typing an address in contacts nothing. The box only starts reading a processor once
              somebody turns it on, which is a separate confirmation.
            </p>
            <form className={styles.form} onSubmit={(event) => void add(event)}>
              <label className={styles.field}>
                <span>Address</span>
                <input
                  value={host}
                  onChange={(event) => setHost(event.target.value)}
                  placeholder="10.0.30.11"
                  inputMode="numeric"
                  required
                />
              </label>
              <label className={styles.field}>
                <span>Name</span>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Main wall"
                />
              </label>
              <button className={styles.add} type="submit">
                Add
              </button>
            </form>
            {addError && <p className={styles.error}>{addError}</p>}
          </section>

          {/* Rendered for everyone, so the section does not appear and vanish
              with other people's unlocks — only the button is privileged, the
              same shape the network audit's deep probe uses. */}
          <section className={styles.admin} aria-label="Sweep for processors">
            <h2 className={styles.sectionTitle}>Sweep for processors</h2>
            {!state.canScan ? (
              <p className={styles.sectionBlurb}>
                This box has no video-network adapter set, so it has nothing to sweep. Pick
                the card on the video network under Admin → Box settings and restart the box, or
                add processors by address above — those are read without it.
              </p>
            ) : (
              <>
                {adminToken ? (
                  <>
                    <p className={styles.sectionBlurb}>
                      One broadcast on {state.interfaceIp}, the same packet NovaLCT sends to find
                      controllers. It runs once when you ask for it and never on a timer. You will
                      be shown exactly what goes on the wire before anything is sent.
                    </p>
                    <button
                      className={styles.scan}
                      onClick={() => void propose('scan')}
                      disabled={state.scanning || busy}
                    >
                      {state.scanning ? 'Sweeping…' : 'Sweep for processors…'}
                    </button>
                  </>
                ) : (
                  // Not the same words with the button removed: "you will be
                  // shown what it sends" is addressed to somebody who can send
                  // it. This says what a sweep is and why this one thing is
                  // privileged when the rest of the pane is not.
                  <p className={styles.sectionBlurb}>
                    A sweep puts one broadcast packet on the whole {state.interfaceIp} network,
                    rather than reading a processor somebody named. That is a decision about the
                    venue&rsquo;s network, so it takes the admin password — an admin can run one
                    from their device.
                  </p>
                )}
              </>
            )}

            {state.scan && (
              <div className={styles.scanResult}>
                <p className={styles.meta}>
                  Last sweep by {state.scan.by}, {state.scan.found.length} answered.
                </p>
                <ul className={styles.sent}>
                  {state.scan.sent.map((line) => (
                    <li key={line}>sent: {line}</li>
                  ))}
                </ul>
                {state.scan.found.map((found) => (
                  <div key={found.host} className={styles.found}>
                    <span className={styles.foundHost}>{found.host}</span>
                    {found.payload && <span className={styles.foundRaw}>{found.payload}</span>}
                    {found.known ? (
                      <span className={styles.meta}>already listed</span>
                    ) : (
                      <button
                        className={styles.addFound}
                        disabled={busy}
                        onClick={() => void act(() => addProcessor(found.host, ''))}
                      >
                        Add
                      </button>
                    )}
                  </div>
                ))}
                {state.scan.errors.map((line) => (
                  <p key={line} className={styles.error}>
                    {line}
                  </p>
                ))}
                {state.scan.found.length > 0 && (
                  <p className={styles.meta}>
                    A processor answers with its address and nothing crewbox can safely read beyond
                    that — whatever follows is shown raw, unlabelled, because nobody has captured a
                    real reply to know what it means.
                  </p>
                )}
              </div>
            )}
          </section>
        </div>
      )}

      {pending && (
        <ConfirmTransmit
          intent={pending.intent}
          busy={busy}
          error={confirmError}
          onConfirm={() => void confirm()}
          onCancel={() => {
            setPending(null)
            setConfirmError('')
          }}
        />
      )}
    </div>
  )
}
