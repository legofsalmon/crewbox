import { Component, useState, type ErrorInfo, type ReactNode } from 'react'
import { describeCrash, type ClientCrash, type Outcome } from '../lib/reports.ts'

/**
 * What a crew member sees when a screen throws, instead of a white page.
 *
 * Without this, one bad render anywhere — a module fed data it did not
 * expect, a browser missing an API — unmounts the whole app and leaves a
 * blank phone in a field with no way back but a reload nobody knows to try.
 *
 * **Nothing the person was doing is lost by it.** Messages they sent and the
 * box has not confirmed are in the IndexedDB outbox, which neither "Try again"
 * nor "Reload" touches. "Try again" remounts only what is inside this
 * boundary, so the store — and the per-channel drafts in the composer, which
 * live outside React — are exactly as they were.
 *
 * **Nothing is sent unless they press Send.** The report goes to the box, not
 * to the internet; the box forwards it when it has a connection (see
 * server/src/reports/).
 */

interface Props {
  children: ReactNode
  /** Rendered at the top of the error screen: a module pane passes its DrawerButton. */
  header?: ReactNode
  /** Change this and the error clears — moving to another channel or module. */
  resetKey?: string
  /** This build's version, sent with the report. */
  version: string
  /** Deliver a report the person chose to send. */
  send: (crash: ClientCrash) => Promise<Outcome>
}

interface State {
  error: unknown
  componentStack: string | undefined
  resetKey: string | undefined
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: undefined, resetKey: this.props.resetKey }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error ?? new Error('Unknown error') }
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    // Navigating away is the most natural "try again" there is.
    if (props.resetKey !== state.resetKey) {
      return { error: null, componentStack: undefined, resetKey: props.resetKey }
    }
    return null
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? undefined })
    // Still in the console for anyone with a cable and devtools.
    console.error(error)
  }

  private reset = (): void => {
    this.setState({ error: null, componentStack: undefined })
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <CrashScreen
        header={this.props.header}
        crash={describeCrash(this.state.error, this.state.componentStack, this.props.version)}
        send={this.props.send}
        onRetry={this.reset}
      />
    )
  }
}

function CrashScreen({
  header,
  crash,
  send,
  onRetry,
}: {
  header?: ReactNode
  crash: ClientCrash
  send: (crash: ClientCrash) => Promise<Outcome>
  onRetry: () => void
}) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  async function onSend() {
    if (busy) return
    setBusy(true)
    const trimmed = note.trim()
    setOutcome(await send(trimmed ? { ...crash, note: trimmed } : crash))
    setBusy(false)
  }

  const done = outcome === 'sent' || outcome === 'saved'

  return (
    <div className="crash-screen" role="alert">
      {header && <header className="empty-pane-head">{header}</header>}
      <div className="crash-body">
        <h2>Something went wrong on this screen</h2>
        <p>
          Your messages are safe. Anything you sent that the box has not confirmed is still queued
          on this device and goes as soon as it can.
        </p>
        <div className="crash-actions">
          <button className="crash-primary" onClick={onRetry}>
            Try again
          </button>
          <button className="crash-secondary" onClick={() => window.location.reload()}>
            Reload the app
          </button>
        </div>
        <details className="crash-report">
          <summary>Send a crash report</summary>
          <p>
            Goes to the crew box, which passes it to LeTissier Creative Studios when it next has
            internet. It holds the error below and nothing else unless you add a note.
          </p>
          <pre className="crash-detail">{crash.summary}</pre>
          {!done && (
            <>
              <label className="confirm-field">
                What were you doing? (optional)
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={2000}
                  rows={3}
                  disabled={busy}
                />
              </label>
              <button className="crash-secondary" onClick={() => void onSend()} disabled={busy}>
                {busy ? 'Sending…' : 'Send report'}
              </button>
            </>
          )}
          {outcome === 'sent' && <p className="crash-note">Sent to the box. Thank you.</p>}
          {outcome === 'saved' && (
            <p className="crash-note">Saved on this device. It goes when the box is reachable.</p>
          )}
          {outcome && typeof outcome === 'object' && (
            <p className="crash-note">{outcome.refused}</p>
          )}
        </details>
      </div>
    </div>
  )
}
