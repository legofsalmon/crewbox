import { useState } from 'react'
import * as api from '../lib/api.ts'
import { adminError } from '../lib/adminerror.ts'
import { crashQuestion } from '../lib/reports.ts'

/**
 * The question the panel asks once after the box crashed: send a report, or
 * don't. Sits above the scroll, like the licence banner, so it is seen on the
 * next open and not again once it has been answered — "Don't send" deletes
 * the report from the box.
 */
export function CrashPrompt({
  reports,
  auth,
  onReports,
  onNote,
}: {
  reports: api.ReportsSummary
  auth: () => api.AdminAuth
  onReports: (reports: api.ReportsSummary) => void
  onNote: (note: string) => void
}) {
  const [always, setAlways] = useState(false)
  const [busy, setBusy] = useState(false)
  const question = crashQuestion(reports.pending)
  if (!question) return null

  async function answer(send: boolean) {
    setBusy(true)
    try {
      const { reports: next } = await api.adminDecideReports(auth(), send, send && always)
      onReports(next)
      onNote(
        send
          ? next.outbound
            ? 'Crash report queued. It goes when the box next has internet.'
            : 'Crash report queued, but this box is set to make no outbound connections.'
          : 'Crash report deleted from this box.'
      )
    } catch (err) {
      onNote(adminError(err, 'Could not save that answer'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="admin-crash-prompt" role="alertdialog" aria-label="Send a crash report?">
      <p>{question}</p>
      <label className="feedback-tick">
        <input
          type="checkbox"
          checked={always}
          onChange={(e) => setAlways(e.target.checked)}
          disabled={busy}
        />
        Always send crash reports
      </label>
      <div className="admin-export">
        <button
          className="admin-btn admin-btn-primary"
          disabled={busy}
          onClick={() => void answer(true)}
        >
          Send
        </button>
        <button className="admin-btn" disabled={busy} onClick={() => void answer(false)}>
          Don’t send
        </button>
      </div>
    </div>
  )
}

/**
 * The setting, and what is waiting. Plain about what goes and what never
 * does, because an organiser has to be able to answer that for their crew.
 */
export default function ReportsSection({
  reports,
  auth,
  onReports,
  onNote,
}: {
  reports: api.ReportsSummary
  auth: () => api.AdminAuth
  onReports: (reports: api.ReportsSummary) => void
  onNote: (note: string) => void
}) {
  const [busy, setBusy] = useState(false)

  async function toggle(on: boolean) {
    setBusy(true)
    try {
      onReports((await api.adminSetAutoSend(auth(), on)).reports)
    } catch (err) {
      onNote(adminError(err, 'Could not change the setting'))
    } finally {
      setBusy(false)
    }
  }

  async function sendNow() {
    setBusy(true)
    try {
      const { result, reports: next } = await api.adminSendReports(auth())
      onReports(next)
      onNote(
        result.sent > 0
          ? `Sent ${result.sent} report${result.sent === 1 ? '' : 's'}.`
          : (next.lastError ?? 'Nothing was sent.')
      )
    } catch (err) {
      onNote(adminError(err, 'Could not send'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <label className="feedback-tick">
        <input
          type="checkbox"
          checked={reports.autoSend}
          onChange={(e) => void toggle(e.target.checked)}
          disabled={busy}
        />
        Send crash reports automatically
      </label>
      <p className="admin-hint">
        Off, the box asks here before sending anything about a crash. A report holds the Crewbox
        version, the operating system, a random id for this install and the error with its stack
        trace — home folders, user names, addresses and anything after “?” in a web address are
        removed on the box first. Never messages, names, files, the event or the licence. Feedback
        goes only when somebody presses Send in “Send feedback…”.
      </p>
      <p className="admin-hint">
        {!reports.outbound
          ? `This box is set to make no outbound connections (CREWBOX_UPDATE_CHECK=0), so ${
              reports.waiting === 1 ? 'the report waiting here stays' : 'reports stay'
            } on the box.`
          : reports.waiting > 0
            ? `${reports.waiting} report${reports.waiting === 1 ? '' : 's'} waiting to go when the box next has internet.`
            : 'Nothing waiting to send.'}
      </p>
      {reports.outbound && reports.waiting > 0 && (
        <div className="admin-export">
          <button className="admin-btn" disabled={busy} onClick={() => void sendNow()}>
            Send now
          </button>
        </div>
      )}
    </>
  )
}
