import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import type { CaptureReport, Diagnostic, Report } from '@crewbox/st2110'
import { checkCapture, loadSt2110 } from '../../../lib/st2110.ts'
import type { CaptureReply, CaptureSdp } from '../../../lib/st2110Capture.ts'
import { useFileDrop } from '../../../lib/useFileDrop.ts'
import {
  SEVERITY_WORDS,
  annotateSdp,
  captureFacts,
  captureTooBig,
  captureVerdict,
  clockNote,
  clockWords,
  count,
  describeFlow,
  describePtpDomain,
  findingWhere,
  identify,
  sdpVerdict,
  size,
  sortFindings,
  streamWords,
  type Verdict,
} from '../model/st2110.ts'
import styles from './St2110Checks.module.scss'

/**
 * The ST 2110 checks, for anyone on the Network page: an SDP file gone
 * through line by line, and a capture measured flow by flow. Both run on
 * this device, with the checks the box itself uses (st2110/README.md), so the
 * file goes nowhere and nothing joins a stream. They need no box, so the
 * page shows them whether or not the audit loads.
 */

/** Past this many, the command line lists the rest: `st2110 pcap`. */
const SHOW_FLOWS = 100
const SHOW_FINDINGS = 200

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const loadFailure = (message: string): string =>
  `Could not load the checks (${message}). They are fetched the first time they are used, ` +
  'so try again once this device can reach the box.'

const VERDICT_CLASS: Record<Verdict['state'], string> = {
  ok: styles.ok!,
  limited: styles.limited!,
  off: styles.off!,
}

export default function St2110Checks() {
  return (
    <>
      <SdpCheck />
      <CaptureCheck />
    </>
  )
}

function Finding({
  severity,
  text,
  meta,
}: Pick<Diagnostic, 'severity'> & { text: string; meta: string }) {
  return (
    <div className={`${styles.finding} ${styles[severity] ?? ''}`}>
      <span className={styles.severity}>{SEVERITY_WORDS[severity]}</span> {text}
      {meta && <span className={styles.meta}>{meta}</span>}
    </div>
  )
}

const diagnosticMeta = (d: Diagnostic): string => [d.rule, d.reference].filter(Boolean).join(' · ')

/* ------------------------------------------------------------ SDP files */

function SdpCheck() {
  const [text, setText] = useState('')
  const [checked, setChecked] = useState<{ text: string; report: Report } | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const picker = useRef<HTMLInputElement>(null)
  // Which check's answer is still wanted: the first one waits for the
  // checks to load, and a second click must not be overtaken by it.
  const generation = useRef(0)

  const check = useCallback(async (source: string) => {
    if (!source.trim()) return
    const mine = ++generation.current
    setBusy(true)
    setNote('')
    try {
      const checks = await loadSt2110()
      if (mine !== generation.current) return
      try {
        setChecked({ text: source, report: checks.lint(source) })
      } catch (err) {
        setChecked(null)
        setNote(`The checks stopped on this file (${messageOf(err)}).`)
      }
    } catch (err) {
      if (mine === generation.current) setNote(loadFailure(messageOf(err)))
    } finally {
      if (mine === generation.current) setBusy(false)
    }
  }, [])

  const open = useCallback(
    async (files: File[]) => {
      const file = files[0]
      if (!file) return
      const picked = await identify(file)
      if (picked.kind === 'sdp') {
        setText(picked.sdp.text)
        void check(picked.sdp.text)
      } else if (picked.kind === 'capture') {
        setNote(`${file.name} is a capture: Check a capture, below, measures one.`)
      } else {
        setNote(picked.why)
      }
    },
    [check]
  )

  const onDropped = useCallback((files: File[]) => void open(files), [open])
  const drop = useFileDrop(onDropped, { disabled: busy })

  const onPicked = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    // Cleared, so choosing the same file again, after editing it, still
    // counts as a choice.
    event.target.value = ''
    void open(files)
  }

  const clear = () => {
    generation.current++
    setText('')
    setChecked(null)
    setNote('')
    setBusy(false)
  }

  return (
    <section
      className={`${styles.panel} ${drop.over ? styles.dropping : ''}`}
      aria-label="Check an SDP file"
      {...drop.handlers}
    >
      <header>
        <h2 className={styles.title}>Check an SDP file</h2>
        <p className={styles.blurb}>
          Goes through it line by line against ST 2110 and says what a receiver would refuse or
          misread. It runs on this device; the file goes nowhere.
        </p>
      </header>
      <textarea
        className={styles.input}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Paste an SDP file here, or drop one on this panel"
        aria-label="SDP file"
        rows={6}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
      />
      <div className={styles.actions}>
        <button
          className={styles.run}
          onClick={() => void check(text)}
          disabled={busy || !text.trim()}
        >
          {busy ? 'Checking…' : 'Check'}
        </button>
        <button className={styles.quiet} onClick={() => picker.current?.click()}>
          Open a file
        </button>
        {(text || checked || note) && (
          <button className={styles.quiet} onClick={clear}>
            Clear
          </button>
        )}
        {/* No `accept`: phones' pickers have no type for .sdp, and grey the file out. */}
        <input ref={picker} type="file" className={styles.file} onChange={onPicked} />
      </div>
      {note && (
        <p className={styles.note} role="status">
          {note}
        </p>
      )}
      {checked && <SdpResult text={checked.text} report={checked.report} />}
    </section>
  )
}

function SdpResult({ text, report }: { text: string; report: Report }) {
  const verdict = sdpVerdict(report)
  const { general, lines } = annotateSdp(text, report)
  return (
    <div className={styles.result}>
      <p className={`${styles.verdict} ${VERDICT_CLASS[verdict.state]}`} role="status">
        {verdict.words}
      </p>
      {general.map((d, i) => (
        <Finding key={i} severity={d.severity} text={d.message} meta={diagnosticMeta(d)} />
      ))}
      <ol className={styles.sdp} aria-label="The file, line by line">
        {lines.map((line) => (
          <li key={line.number} className={styles.sdpLine}>
            <div className={styles.lineText}>
              <span className={styles.lineNumber} aria-hidden="true">
                {line.number}
              </span>
              <code>{line.text || ' '}</code>
            </div>
            {(line.stream || line.diagnostics.length > 0) && (
              <div className={styles.annotations}>
                {line.stream && <p className={styles.stream}>{streamWords(line.stream)}</p>}
                {line.diagnostics.map((d, i) => (
                  <Finding
                    key={i}
                    severity={d.severity}
                    text={d.message}
                    meta={diagnosticMeta(d)}
                  />
                ))}
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}

/* ------------------------------------------------------------- captures */

type CaptureRun =
  | { kind: 'running' }
  | { kind: 'done'; name: string; report: CaptureReport }
  | { kind: 'failed'; message: string }

/** The page's words for a reply that has no report in it. */
function failureWords(reply: Extract<CaptureReply, { ok: false }>, name: string): string {
  if (reply.stage === 'load') return loadFailure(reply.message)
  if (reply.stage === 'read') return `Could not read ${name} (${reply.message}).`
  return (
    `The analyser stopped on ${name}: ${reply.message}. A very large capture can be too much ` +
    'for a browser; editcap can cut one down.'
  )
}

function CaptureCheck() {
  const [capture, setCapture] = useState<File | null>(null)
  const [sdp, setSdp] = useState<CaptureSdp[]>([])
  const [notes, setNotes] = useState<string[]>([])
  const [run, setRun] = useState<CaptureRun | null>(null)
  const picker = useRef<HTMLInputElement>(null)
  const running = useRef<AbortController | null>(null)

  // Leaving the page stops the analyser, and hands its memory back.
  useEffect(() => () => running.current?.abort(), [])

  const add = useCallback(async (files: File[]) => {
    const picked = await Promise.all(files.map(identify))
    const refused: string[] = []
    const captures: File[] = []
    const added: CaptureSdp[] = []
    for (const p of picked) {
      if (p.kind === 'refused') refused.push(p.why)
      else if (p.kind === 'sdp') added.push(p.sdp)
      else {
        const tooBig = captureTooBig(p.file)
        if (tooBig) refused.push(tooBig)
        else captures.push(p.file)
      }
    }
    const [kept, ...others] = captures
    if (others.length > 0) refused.push(`One capture at a time: ${kept.name} is the one kept.`)
    if (kept) setCapture(kept)
    if (added.length > 0) {
      // A file chosen again replaces the copy already here, by name.
      setSdp((had) => [...had.filter((h) => !added.some((a) => a.name === h.name)), ...added])
    }
    // A report on screen is about the files it was made from.
    if (kept || added.length > 0) setRun(null)
    setNotes(refused)
  }, [])

  const busy = run?.kind === 'running'
  const onDropped = useCallback((files: File[]) => void add(files), [add])
  const drop = useFileDrop(onDropped, { disabled: busy })

  const onPicked = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    void add(files)
  }

  async function start() {
    if (!capture) return
    running.current?.abort()
    const controller = new AbortController()
    running.current = controller
    setRun({ kind: 'running' })
    try {
      const reply = await checkCapture(capture, sdp, controller.signal)
      setRun(
        reply.ok
          ? { kind: 'done', name: capture.name, report: reply.report }
          : { kind: 'failed', message: failureWords(reply, capture.name) }
      )
    } catch {
      // Stopped: `stop` or `clear` has already said what happens next.
    } finally {
      if (running.current === controller) running.current = null
    }
  }

  const stop = () => {
    running.current?.abort()
    setRun(null)
  }

  const clear = () => {
    stop()
    setCapture(null)
    setSdp([])
    setNotes([])
  }

  return (
    <section
      className={`${styles.panel} ${drop.over ? styles.dropping : ''}`}
      aria-label="Check a capture"
      {...drop.handlers}
    >
      <header>
        <h2 className={styles.title}>Check a capture</h2>
        <p className={styles.blurb}>
          Measures each RTP flow and the PTP messages in a pcap or pcapng file, as SMPTE RP 2110-25
          describes. Add the SDP files of its streams to check each flow against its own. It runs on
          this device; the file goes nowhere.
        </p>
      </header>
      <div className={styles.picked}>
        {capture ? (
          <p>
            <strong>{capture.name}</strong>{' '}
            <span className={styles.muted}>({size(capture.size)})</span>
          </p>
        ) : (
          <p className={styles.muted}>No capture yet: choose one, or drop it on this panel.</p>
        )}
        {sdp.length > 0 && <p className={styles.muted}>With {sdp.map((s) => s.name).join(', ')}</p>}
      </div>
      <div className={styles.actions}>
        {/* Until there is a capture, choosing one is the thing to do. */}
        {capture ? (
          <button className={styles.run} onClick={() => void start()} disabled={busy}>
            {busy ? 'Checking…' : 'Check'}
          </button>
        ) : (
          <button className={styles.run} onClick={() => picker.current?.click()}>
            Choose files
          </button>
        )}
        {busy ? (
          <button className={styles.quiet} onClick={stop}>
            Stop
          </button>
        ) : (
          capture && (
            <button className={styles.quiet} onClick={() => picker.current?.click()}>
              Add files
            </button>
          )
        )}
        {!busy && (capture || sdp.length > 0 || run) && (
          <button className={styles.quiet} onClick={clear}>
            Clear
          </button>
        )}
        {/* No `accept`: files are told apart by what is in them (`identify`). */}
        <input ref={picker} type="file" multiple className={styles.file} onChange={onPicked} />
      </div>
      {busy && capture && (
        <p className={styles.muted} role="status">
          Reading {size(capture.size)} on this device. A big capture takes a while; the page keeps
          working meanwhile.
        </p>
      )}
      {notes.map((n, i) => (
        <p key={i} className={styles.note} role="status">
          {n}
        </p>
      ))}
      {run?.kind === 'failed' && (
        <p className={styles.note} role="status">
          {run.message}
        </p>
      )}
      {run?.kind === 'done' && <CaptureResult report={run.report} />}
    </section>
  )
}

function CaptureResult({ report }: { report: CaptureReport }) {
  const verdict = captureVerdict(report)
  const findings = sortFindings(report.findings)
  const note = clockNote(report.timescale)
  const { capture, flows } = report
  const hidden = {
    findings: Math.max(0, findings.length - SHOW_FINDINGS),
    flows: Math.max(0, flows.length - SHOW_FLOWS),
  }
  return (
    <div className={styles.result}>
      <p className={`${styles.verdict} ${VERDICT_CLASS[verdict.state]}`} role="status">
        {verdict.words}
      </p>
      <p className={styles.facts}>{captureFacts(report)}</p>
      <p className={styles.facts}>{clockWords(report.timescale)}</p>
      {note && <p className={styles.facts}>{note}</p>}
      {capture.error && (
        <Finding
          severity="error"
          text={`The file stops partway: ${capture.error}. The analysis stops there.`}
          meta=""
        />
      )}
      {findings.slice(0, SHOW_FINDINGS).map((f, i) => (
        <Finding
          key={i}
          severity={f.severity}
          text={f.message}
          meta={[findingWhere(f, flows), f.rule, f.reference].filter(Boolean).join(' · ')}
        />
      ))}
      {hidden.findings > 0 && (
        <p className={styles.muted}>
          …and {count(hidden.findings, 'finding')} more; the st2110 command lists them all.
        </p>
      )}
      {report.missing.map((m) => (
        <Finding key={m} severity="warning" text={`Not in the capture: ${m}.`} meta="" />
      ))}
      {flows.length > 0 && (
        <>
          <h3 className={styles.subhead}>Flows</h3>
          <ul className={styles.described}>
            {flows.slice(0, SHOW_FLOWS).map((flow) => {
              const { heading, details } = describeFlow(flow)
              return (
                <li key={flow.index}>
                  <div className={styles.heading}>{heading}</div>
                  {details.map((d, i) => (
                    <div key={i} className={styles.detail}>
                      {d}
                    </div>
                  ))}
                </li>
              )
            })}
          </ul>
          {hidden.flows > 0 && (
            <p className={styles.muted}>
              …and {count(hidden.flows, 'flow')} more; the st2110 command lists them all.
            </p>
          )}
        </>
      )}
      {report.ptp.domains.length > 0 && (
        <>
          <h3 className={styles.subhead}>PTP</h3>
          <ul className={styles.described}>
            {report.ptp.domains.map((domain) => {
              const { heading, details } = describePtpDomain(domain)
              return (
                <li key={domain.domain}>
                  <div className={styles.heading}>{heading}</div>
                  {details.map((d, i) => (
                    <div key={i} className={styles.detail}>
                      {d}
                    </div>
                  ))}
                </li>
              )
            })}
          </ul>
        </>
      )}
    </div>
  )
}
