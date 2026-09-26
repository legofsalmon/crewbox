import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from 'react'
import type { Channel, User } from '@crewbox/shared'
import { sessionToken, useStore } from '../store.ts'
import * as api from '../lib/api.ts'
import { deliveredNote, deliverFile, NO_DOWNLOADS } from '../lib/download.ts'
import { adminError } from '../lib/adminerror.ts'
import { adapterMissing, describeAnnounce, listeningMode } from '../lib/adminnetwork.ts'
import UpdateSection from './UpdateSection.tsx'
import LicenceSection from './LicenceSection.tsx'
import ReportsSection, { CrashPrompt } from './ReportsSection.tsx'
import BoxSettingsSection from './BoxSettingsSection.tsx'
import { licenceBanner } from '../lib/licence.ts'
import { addressOf } from '../lib/discovery.ts'
import { knownEvents, openEvent, subscribeKnownEvents, type KnownEvent } from '../lib/eventScope.ts'

const PIN_RE = /^\d{4,8}$/

/** How soon the panel asks again while the box is still claiming its name. */
const ANNOUNCE_RECHECK_MS = 1000

/**
 * Session plus unlock. Read from the store rather than passed down, because
 * every row in this panel needs it and threading it through would be noise.
 * The admin token is only ever non-null while this component is mounted —
 * App.tsx renders the unlock screen instead when it isn't.
 */
function auth(): api.AdminAuth {
  return {
    token: sessionToken() ?? '',
    adminToken: useStore.getState().adminToken ?? '',
  }
}

export default function AdminPanel() {
  const setAdminOpen = useStore((s) => s.setAdminOpen)
  const lockAdmin = useStore((s) => s.lockAdmin)
  const users = useStore((s) => s.users)
  const online = useStore((s) => s.online)
  const channels = useStore((s) => s.channels)
  const me = useStore((s) => s.me)

  const [note, setNote] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  /**
   * Null until loaded, and for good on a box that has no licensing at all
   * (an older server answers 404) — the section and the banner are simply
   * not there, rather than a row saying it could not tell.
   */
  const [licence, setLicence] = useState<api.LicenceStatus | null>(null)
  /** Null on a box without crash reporting (an older server answers 404). */
  const [reports, setReports] = useState<api.ReportsSummary | null>(null)

  useEffect(() => {
    let live = true
    api
      .adminGetLicence(auth())
      .then(({ licence: l }) => live && setLicence(l))
      .catch(() => {})
    api
      .adminGetReports(auth())
      .then(({ reports: r }) => live && setReports(r))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  const banner = licenceBanner(licence)

  const crew = useMemo(
    () =>
      Object.values(users).sort(
        (a, b) =>
          Number(online[b.id] ?? false) - Number(online[a.id] ?? false) ||
          a.name.localeCompare(b.name)
      ),
    [users, online]
  )
  const publicChannels = useMemo(
    () =>
      Object.values(channels)
        .filter((c) => c.kind === 'public' && !c.retired)
        .sort((a, b) => a.createdAt - b.createdAt),
    [channels]
  )

  async function downloadExport() {
    setExporting(true)
    try {
      const blob = await api.adminExport(auth())
      const name = `crewbox-export-${new Date().toISOString().slice(0, 10)}.json`
      setNote(deliveredNote(await deliverFile(name, blob), 'Export'))
    } catch (err) {
      setNote(adminError(err, 'Export failed'))
    } finally {
      setExporting(false)
    }
  }

  return (
    <div
      className="admin-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) setAdminOpen(false)
      }}
      onKeyDown={(e) => e.key === 'Escape' && setAdminOpen(false)}
    >
      <div className="admin-panel" role="dialog" aria-label="Admin panel">
        <header className="admin-head">
          <h2>Admin</h2>
          {/* Closing the panel leaves it unlocked for the rest of the session,
              which is what makes it usable during a shift. Lock is the way to
              end that deliberately — before handing the phone to someone. */}
          <button className="admin-btn" onClick={lockAdmin}>
            Lock
          </button>
          <button
            className="icon-btn"
            aria-label="Close admin panel"
            onClick={() => setAdminOpen(false)}
          >
            ✕
          </button>
        </header>
        {/* Outside the scroll, so it stays put while the admin works: the
            watermark policy's whole meaning is that this is not missed. */}
        {banner && (
          <div className="admin-licence-banner" role="status">
            <span>{banner}</span>
            <button
              className="admin-btn"
              onClick={() =>
                document
                  .getElementById('admin-licence')
                  ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }
            >
              Licence
            </button>
          </div>
        )}
        {reports && (
          <CrashPrompt reports={reports} auth={auth} onReports={setReports} onNote={setNote} />
        )}
        {note && <div className="admin-note">{note}</div>}
        <div className="admin-scroll">
          <section>
            <h3 className="admin-section-title">Crew</h3>
            <ul>
              {crew.map((user) => (
                <UserRow
                  key={user.id}
                  user={user}
                  online={!!online[user.id]}
                  isMe={user.id === me?.id}
                  onNote={setNote}
                />
              ))}
            </ul>
          </section>
          <section>
            <h3 className="admin-section-title">Channels</h3>
            <ul>
              {publicChannels.map((channel) => (
                <ChannelRow key={channel.id} channel={channel} onNote={setNote} />
              ))}
            </ul>
          </section>
          <section>
            <h3 className="admin-section-title">This box</h3>
            <ServerSection onNote={setNote} locked={licence?.locked ?? false} />
          </section>
          <section>
            <h3 className="admin-section-title">This network</h3>
            <p className="admin-hint">
              What the box has been plugged into. No internet is normal on site — nothing here needs
              it.
            </p>
            <Environment onNote={setNote} />
          </section>
          <section>
            <h3 className="admin-section-title">Box settings</h3>
            <BoxSettingsSection auth={auth} onNote={setNote} locked={licence?.locked ?? false} />
          </section>
          {licence && (
            <section>
              <h3 className="admin-section-title">Licence</h3>
              <LicenceSection
                licence={licence}
                auth={auth}
                onLicence={setLicence}
                onNote={setNote}
              />
            </section>
          )}
          {reports && (
            <section>
              <h3 className="admin-section-title">Crash reports</h3>
              <ReportsSection
                reports={reports}
                auth={auth}
                onReports={setReports}
                onNote={setNote}
              />
            </section>
          )}
          <section>
            <h3 className="admin-section-title">Export</h3>
            <p className="admin-hint">
              Download every user, channel and message as a JSON file for the post-event archive.
            </p>
            <div className="admin-export">
              <button
                className="admin-btn"
                disabled={exporting}
                onClick={() => void downloadExport()}
              >
                {exporting ? 'Preparing…' : 'Download chat logs'}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

/** Enabled modules from live config (chosen under Box settings below). */
function ModulesList() {
  const configModules = useStore((s) => s.config.modules)
  return (
    <>
      {configModules.join(', ')} <span className="admin-muted">(chosen under Box settings)</span>
    </>
  )
}

const STATE_LABEL: Record<api.EnvState, string> = {
  ok: 'Working',
  limited: 'Limited',
  off: 'Off',
  // Not "Unknown" or "Warning": this state means there is nothing to fix,
  // and the label is read aloud by screen readers.
  info: 'For information',
}

const STATE_DOT: Record<api.EnvState, string> = {
  ok: '●',
  limited: '◐',
  off: '○',
  info: '·',
}

/**
 * Rows for both panels: what this box can do (readiness) and what it has been
 * plugged into (environment). One component because they are the same idea at
 * two scopes, and an admin should not have to learn two vocabularies.
 */
function Readiness({ checks }: { checks: (api.ReadinessCheck | api.EnvCheck)[] }) {
  return (
    <ul className="readiness">
      {checks.map((check) => (
        <li key={check.id} className={`readiness-row readiness-${check.state}`}>
          <span className="readiness-state" aria-label={STATE_LABEL[check.state]}>
            {STATE_DOT[check.state]}
          </span>
          <div className="readiness-body">
            <span className="readiness-label">{check.label}</span>
            <span className="readiness-detail">{check.detail}</span>
            {check.fix && <span className="readiness-fix">{check.fix}</span>}
          </div>
        </li>
      ))}
    </ul>
  )
}

/** How long ago the environment was probed, for the "checked" line. */
function ago(ms: number): string {
  const mins = Math.floor((Date.now() - ms) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.floor(mins / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

/**
 * The network around the box, as opposed to the box itself.
 *
 * Probed rather than rendered live: finding out there is no uplink is done by
 * waiting for a timeout, and an admin panel that stalls on that is worse than
 * one showing a result from a minute ago. Refresh is a button because the
 * answer only changes when someone changes the site.
 */
function Environment({ onNote }: { onNote: (note: string) => void }) {
  const [report, setReport] = useState<api.EnvironmentReport | null>(null)
  const [busy, setBusy] = useState(false)

  const load = (refresh: boolean) => {
    setBusy(true)
    api
      .adminGetEnvironment(auth(), refresh)
      .then(setReport)
      .catch((err) => onNote(adminError(err, 'Could not check')))
      .finally(() => setBusy(false))
  }

  useEffect(() => {
    let live = true
    api
      .adminGetEnvironment(auth())
      .then((r) => live && setReport(r))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  async function downloadDns() {
    try {
      const blob = await api.adminDnsConfig(auth())
      const result = await deliverFile('crewbox-dns.conf', blob)
      if (result === 'unavailable') onNote(NO_DOWNLOADS)
      else if (result !== 'cancelled') {
        onNote(
          `${deliveredNote(result, 'DNS config') ?? 'DNS config ready'} — put it on the venue router`
        )
      }
    } catch (err) {
      onNote(adminError(err, 'Could not build the DNS config'))
    }
  }

  const pending = !report || report.pending
  return (
    <>
      {pending ? (
        <p className="admin-hint">Checking the network around this box…</p>
      ) : (
        <Readiness checks={report.checks} />
      )}
      <div className="admin-export">
        <button className="admin-btn" disabled={busy} onClick={() => load(true)}>
          {busy ? 'Checking…' : 'Check again'}
        </button>
        {/* Always offered: besides fixing the name, it carries the probe
            block the "Phones stay on this Wi-Fi" line in This box asks for,
            on every box. It used to appear only when the name was wrong, and
            that line pointed at nothing. */}
        {!pending && (
          <button className="admin-btn" onClick={() => void downloadDns()}>
            Download DNS config
          </button>
        )}
        {!pending && <span className="admin-muted">Checked {ago(report.probedAt)}</span>}
      </div>
    </>
  )
}

/** One save-on-submit text setting. Three of these, so it's a component. */
function SettingField({
  id,
  label,
  value,
  saved,
  placeholder,
  minLength,
  saving,
  disabled = false,
  onChange,
  onSave,
}: {
  id: string
  label: string
  value: string
  /** What the server currently holds — Save is off until they differ. */
  saved: string | undefined
  placeholder: string
  minLength?: number
  saving: boolean
  /** Refused by the box right now; the reason is shown above the fields. */
  disabled?: boolean
  onChange: (value: string) => void
  onSave: (e: FormEvent) => void
}) {
  const tooShort = minLength !== undefined && value.trim().length < minLength
  return (
    <form className="admin-setting" onSubmit={onSave}>
      <label htmlFor={id}>{label}</label>
      <div className="admin-setting-row">
        <input
          id={id}
          value={value}
          minLength={minLength}
          maxLength={64}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          className="admin-btn"
          disabled={disabled || saving || saved === undefined || tooShort || value === saved}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  )
}

function ServerSection({
  onNote,
  locked,
}: {
  onNote: (note: string) => void
  /** The lock policy is withholding event configuration until a licence is entered. */
  locked: boolean
}) {
  const [data, setData] = useState<api.AdminSettings | null>(null)
  const [eventName, setEventName] = useState('')
  const [ssid, setSsid] = useState('')
  const [pin, setPin] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let live = true
    api
      .adminGetSettings(auth())
      .then((d) => {
        if (!live) return
        setData(d)
        setEventName(d.settings.eventName)
        setSsid(d.settings.wifiSsid)
        setPin(d.serverInfo.eventPin)
      })
      .catch((err) => onNote(adminError(err, 'Could not load settings')))
    return () => {
      live = false
    }
  }, [onNote])

  /**
   * Follows the announcement until it has claimed its name. A change comes
   * back while the box is still probing, which takes about a second, and the
   * line under the setting would otherwise say "Starting" until the panel was
   * next opened. Each answer is a new object, so this asks again while the
   * box is still starting and stops once it says anything else.
   */
  const announce = data?.network.announce
  useEffect(() => {
    if (announce?.state !== 'starting') return
    let live = true
    const timer = window.setTimeout(() => {
      api
        .adminGetSettings(auth())
        .then((d) => {
          if (live) setData((cur) => (cur ? { ...cur, network: d.network } : cur))
        })
        .catch(() => {
          // Left as it was: the next change, or opening the panel, reads it again.
        })
    }, ANNOUNCE_RECHECK_MS)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [announce])

  /** Patch one setting, then refresh local state from what the server kept. */
  function save(
    patch: Parameters<typeof api.adminUpdateSettings>[1],
    note: string
  ): (e: FormEvent) => void {
    return (e) => {
      e.preventDefault()
      setSaving(true)
      void api
        .adminUpdateSettings(auth(), patch)
        .then(({ settings, network }) => {
          setEventName(settings.eventName)
          setSsid(settings.wifiSsid)
          setPin(settings.eventPin)
          setData((d) =>
            d
              ? {
                  ...d,
                  settings: {
                    ...d.settings,
                    eventName: settings.eventName,
                    wifiSsid: settings.wifiSsid,
                  },
                  serverInfo: { ...d.serverInfo, eventPin: settings.eventPin },
                  // A renamed event is announced under its new name, and the
                  // line under the setting should say so.
                  ...(network ? { network } : {}),
                }
              : d
          )
          onNote(note)
        })
        .catch((err) => onNote(adminError(err, 'Save failed')))
        .finally(() => setSaving(false))
    }
  }

  /** Say which event this box carries on, then show what the box kept. */
  function saveContinues(continues: api.Continues | null, note: string) {
    setSaving(true)
    void api
      .adminUpdateSettings(auth(), { continues })
      .then(({ settings }) => {
        setData((d) =>
          d ? { ...d, settings: { ...d.settings, continues: settings.continues ?? null } } : d
        )
        onNote(note)
      })
      .catch((err) => onNote(adminError(err, 'Save failed')))
      .finally(() => setSaving(false))
  }

  /** Patch network settings, then show what the box now reports. */
  function saveNetwork(patch: Parameters<typeof api.adminUpdateSettings>[1], note: string) {
    setSaving(true)
    void api
      .adminUpdateSettings(auth(), patch)
      .then(({ network: fresh }) => {
        setData((d) => (d && fresh ? { ...d, network: fresh } : d))
        onNote(note)
      })
      .catch((err) => onNote(adminError(err, 'Save failed')))
      .finally(() => setSaving(false))
  }

  /**
   * The rule that gets port 80 to this box's probe responder.
   *
   * Through the same path as every other export: this one was a bare anchor
   * click, which in the apps saved nothing and still said "downloaded".
   */
  async function downloadPort80() {
    try {
      const blob = await api.adminPort80Config(auth())
      const result = await deliverFile('crewbox-port80.conf', blob)
      if (result === 'unavailable') onNote(NO_DOWNLOADS)
      else if (result !== 'cancelled') {
        const done = deliveredNote(result, 'Port 80 config') ?? 'Port 80 config ready'
        onNote(`${done} — one rule, run it on this machine`)
      }
    } catch (err) {
      onNote(adminError(err, 'Could not build the port 80 config'))
    }
  }

  const info = data?.serverInfo
  return (
    <>
      {data && <Readiness checks={data.readiness} />}
      {/* Only when the responder actually landed on a fallback port. A box
          holding port 80 needs no rule, and offering one would suggest
          something is wrong when nothing is. */}
      {info?.portRedirect && (
        <div className="admin-export">
          <button className="admin-btn" onClick={() => void downloadPort80()}>
            Download port 80 config
          </button>
        </div>
      )}
      {data?.lighting && data.lighting.length > 0 && (
        <>
          <h3 className="admin-subhead">Lighting network</h3>
          <Readiness checks={data.lighting} />
        </>
      )}
      {data?.media && data.media.length > 0 && (
        <>
          <h3 className="admin-subhead">Audio &amp; media network</h3>
          <Readiness checks={data.media} />
        </>
      )}
      {locked && (
        <p className="admin-hint admin-licence-locked">
          Event name, Wi-Fi and networks are locked until this box has a licence — see Licence
          below. The event PIN and admin password always work.
        </p>
      )}
      <SettingField
        id="admin-event-name"
        label="Event name (shown to crew instead of “Crewbox”)"
        value={eventName}
        saved={data?.settings.eventName}
        placeholder="e.g. Ashton Court 2026"
        saving={saving}
        disabled={locked}
        onChange={setEventName}
        onSave={save({ eventName: eventName.trim() }, 'Event name saved')}
      />
      <SettingField
        id="admin-event-pin"
        label="Event PIN (gates new joins; on the poster and /connect)"
        value={pin}
        saved={data?.serverInfo.eventPin}
        placeholder="e.g. 2468"
        minLength={4}
        saving={saving}
        onChange={setPin}
        onSave={save(
          { eventPin: pin.trim() },
          'Event PIN changed — update the poster or point crew at /connect'
        )}
      />
      <SettingField
        id="admin-ssid"
        label="Wi-Fi network (shown as join guidance)"
        value={ssid}
        saved={data?.settings.wifiSsid}
        placeholder="e.g. CrewNet"
        saving={saving}
        disabled={locked}
        onChange={setSsid}
        onSave={save({ wifiSsid: ssid.trim() }, 'Wi-Fi network saved')}
      />
      {data && (
        <ContinuesField saved={data.settings.continues} saving={saving} onSave={saveContinues} />
      )}
      {data?.network && (
        <NetworksSection
          network={data.network}
          saving={saving}
          disabled={locked}
          onSave={saveNetwork}
        />
      )}
      {data?.network.announce && (
        <AnnounceSection status={data.network.announce} saving={saving} onSave={saveNetwork} />
      )}
      {info && <AdminPasswordField fromEnv={info.adminPasswordFromEnv} onNote={onNote} />}
      {/*
        Above the info list rather than inside it: everything below is a fact
        about the box, and this is the one thing on the screen that asks for a
        decision. It renders nothing at all when there is no news.
      */}
      <UpdateSection auth={auth} onNote={onNote} />
      {info && (
        <dl className="admin-info">
          <div>
            <dt>Version</dt>
            <dd>
              {info.version}
              {/* Only when there is news. A box that is current, or one told
                  not to check, says nothing rather than "up to date" — a row
                  that is almost always the same word is a row nobody reads. */}
              {info.update?.available && (
                <>
                  {' — '}
                  <a
                    className="admin-update"
                    href={info.update.available.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {info.update.available.version} available
                  </a>
                </>
              )}
            </dd>
          </div>
          <div>
            <dt>Modules</dt>
            <dd>
              <ModulesList />
            </dd>
          </div>
          <div>
            <dt>Uptime</dt>
            <dd>{formatUptime(info.uptimeSec)}</dd>
          </div>
          <div>
            <dt>Online</dt>
            <dd>
              {info.onlineUsers} crew · {info.connections} connections
            </dd>
          </div>
          <div>
            <dt>Voice</dt>
            <dd>{info.voiceEnabled ? 'Enabled' : 'Not configured'}</dd>
          </div>
          {/* The key a vision desk drives tally with. Printed here for the
              same reason as the event PIN: the box mints it silently on
              first use, and a key nobody can find is a feature nobody has.
              It grants far less than the password guarding this panel. */}
          {info.controlKey && (
            <div>
              <dt>Desk control key</dt>
              <dd className="admin-key">{info.controlKey}</dd>
            </div>
          )}
        </dl>
      )}
    </>
  )
}

/**
 * Which adapter faces the crew, and which the lighting listener reads.
 *
 * Dropdowns of the adapters the machine actually has, because the on-site
 * alternative was a terminal, an ipconfig, and an environment variable. The
 * advertised join links follow a save immediately; the socket binding and
 * the lighting listener follow at the next start, and the readiness panel
 * says so for as long as that gap exists rather than pretending.
 */
function NetworksSection({
  network,
  onSave,
  saving,
  disabled = false,
}: {
  network: api.AdminNetwork
  onSave: (patch: Parameters<typeof api.adminUpdateSettings>[1], note: string) => void
  saving: boolean
  /** Refused by the box right now (the licence lock); said once, above. */
  disabled?: boolean
}) {
  const [crewIface, setCrewIface] = useState(network.saved.crewIface)
  const [dmxMode, setDmxMode] = useState(network.saved.dmxMode || 'off')
  const [dmxIface, setDmxIface] = useState(network.saved.dmxIface)
  const [universes, setUniverses] = useState(network.saved.dmxUniverses)

  /**
   * The adapter list, plus whatever is currently selected if it is not on it.
   *
   * An address saved last week and gone this morning — a USB-to-Ethernet
   * dongle left in the van, a Wi-Fi network not joined yet — otherwise made
   * the select fall back to showing the blank option. So the panel said "All
   * networks" while the box was pinned to an adapter that is not there, and
   * choosing the blank option registered as no change and saved nothing.
   */
  const adapterOptions = (blank: string, current: string) => (
    <>
      <option value="">{blank}</option>
      {network.adapters.map((a) => (
        <option key={`${a.name}-${a.address}`} value={a.address}>
          {a.address} — {a.name}
        </option>
      ))}
      {adapterMissing(network.adapters, current) && (
        <option value={current}>{current} — not connected</option>
      )}
    </>
  )

  /**
   * Whether this box is listening to a lighting network at all.
   *
   * Not `dmxMode`, which comes from what has been *saved*. With CREWBOX_DMX
   * pinning the mode and nothing ever saved through the panel, that is empty
   * — so the panel concluded lighting was off and hid the adapter and
   * universes fields, which the environment does not pin and are the two an
   * operator on such a box actually has to set.
   */
  const effectiveMode = listeningMode(network, dmxMode)

  const dirty =
    crewIface !== network.saved.crewIface ||
    dmxMode !== (network.saved.dmxMode || 'off') ||
    dmxIface !== network.saved.dmxIface ||
    universes !== network.saved.dmxUniverses

  return (
    <form
      className="admin-networks"
      onSubmit={(e) => {
        e.preventDefault()
        onSave(
          {
            ...(network.fromEnv.iface ? {} : { crewIface }),
            ...(network.fromEnv.dmxMode
              ? {}
              : { dmxMode: dmxMode as 'off' | 'artnet' | 'sacn' | 'both' }),
            ...(network.fromEnv.dmxIface ? {} : { dmxIface }),
            ...(network.fromEnv.dmxUniverses ? {} : { dmxUniverses: universes.trim() }),
          },
          'Network settings saved — join links updated now; restart the box to apply the rest'
        )
      }}
    >
      <h3 className="admin-subhead">Networks</h3>
      {network.restartNeeded && (
        <p className="admin-note">
          Saved settings differ from what this box started with — restart it to apply them.
        </p>
      )}
      <label htmlFor="admin-crew-iface">Crew network</label>
      {network.fromEnv.iface ? (
        <p className="admin-note">Set by CREWBOX_IFACE in the environment; change it there.</p>
      ) : (
        <select
          id="admin-crew-iface"
          value={crewIface}
          onChange={(e) => setCrewIface(e.target.value)}
        >
          {adapterOptions('All networks — first adapter wins', crewIface)}
        </select>
      )}
      <label htmlFor="admin-dmx-mode">Lighting network listening</label>
      {network.fromEnv.dmxMode ? (
        <p className="admin-note">
          Set by CREWBOX_DMX in the environment{effectiveMode ? ` to ${effectiveMode}` : ''}; change
          it there.
        </p>
      ) : (
        <select id="admin-dmx-mode" value={dmxMode} onChange={(e) => setDmxMode(e.target.value)}>
          <option value="off">Off</option>
          <option value="sacn">sACN</option>
          <option value="artnet">Art-Net</option>
          <option value="both">Both</option>
        </select>
      )}
      {effectiveMode !== 'off' && (
        <>
          <label htmlFor="admin-dmx-iface">Lighting network adapter</label>
          {network.fromEnv.dmxIface ? (
            <p className="admin-note">Set by CREWBOX_DMX_IFACE in the environment.</p>
          ) : (
            <select
              id="admin-dmx-iface"
              value={dmxIface}
              onChange={(e) => setDmxIface(e.target.value)}
            >
              {adapterOptions('Let the OS choose', dmxIface)}
            </select>
          )}
          <label htmlFor="admin-dmx-universes">sACN universes</label>
          {network.fromEnv.dmxUniverses ? (
            <p className="admin-note">Set by CREWBOX_DMX_UNIVERSES in the environment.</p>
          ) : (
            <input
              id="admin-dmx-universes"
              value={universes}
              placeholder="1-16"
              maxLength={200}
              onChange={(e) => setUniverses(e.target.value)}
            />
          )}
        </>
      )}
      <button className="admin-btn" type="submit" disabled={disabled || saving || !dirty}>
        {saving ? 'Saving…' : 'Save networks'}
      </button>
    </form>
  )
}

const eventNamed = (event: { name: string }): string => event.name.trim() || 'No name yet'

/**
 * Which event this box carries on: a spare with no backup, or a bigger box,
 * taking over from an event's box (server/src/continues.ts). Phones holding
 * that event offer to bring their work here once they have joined.
 *
 * The events offered are the ones this device holds, other than this box's
 * own. An event's ID is nothing anybody types, and a device can only name an
 * event it has been on. The box's own answer shows whichever device reads it.
 */
export function ContinuesField({
  saved,
  saving,
  onSave,
}: {
  /** What the box holds now; undefined from a box that predates it. */
  saved: api.Continues | null | undefined
  saving: boolean
  onSave: (continues: api.Continues | null, note: string) => void
}) {
  const events = useSyncExternalStore(subscribeKnownEvents, knownEvents)
  const open = openEvent()
  const others: KnownEvent[] = events
    .filter((event) => event.id !== open)
    .sort((a, b) => b.seenAt - a.seenAt)
  const [picked, setPicked] = useState(saved?.id ?? '')
  useEffect(() => setPicked(saved?.id ?? ''), [saved?.id])
  if (saved === undefined) return null
  // The box's answer, for a device that was never on that event.
  const notHeld = saved && !others.some((event) => event.id === saved.id) ? saved : null

  function submit(e: FormEvent) {
    e.preventDefault()
    if (!picked) {
      onSave(null, 'Saved: this box carries on no other event')
      return
    }
    const event = others.find((known) => known.id === picked)
    if (!event) return
    onSave(
      { id: event.id, name: event.name.trim() },
      `Saved: phones that have ${eventNamed(event)} will offer to bring its work here`
    )
  }

  return (
    <form className="admin-setting" onSubmit={submit}>
      <label htmlFor="admin-continues">Carries on another event</label>
      <div className="admin-setting-row">
        <select
          id="admin-continues"
          value={picked}
          disabled={saving}
          onChange={(e) => setPicked(e.target.value)}
        >
          <option value="">No, it’s a new event</option>
          {notHeld && <option value={notHeld.id}>{eventNamed(notHeld)}</option>}
          {others.map((event) => (
            <option key={event.id} value={event.id}>
              {event.origin
                ? `${eventNamed(event)} · ${addressOf(event.origin)}`
                : eventNamed(event)}
            </option>
          ))}
        </select>
        <button className="admin-btn" disabled={saving || picked === (saved?.id ?? '')}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      <p className="admin-help">
        For a spare with no backup, or a bigger box, taking over from an event’s box. Phones that
        have that event offer to bring its documents, running order and unsent messages here. Chat
        history comes back only from a backup. The events listed are the ones this device has been
        on.
      </p>
    </form>
  )
}

/**
 * Whether the apps can find this box on the crew network by themselves.
 *
 * Its own control rather than a field of the Networks form: it takes effect
 * the moment it changes, where the form's settings wait for a restart, and
 * a note saying "restart to apply" beside it would be wrong.
 */
function AnnounceSection({
  status,
  saving,
  onSave,
}: {
  status: api.AnnounceStatus
  saving: boolean
  onSave: (patch: Parameters<typeof api.adminUpdateSettings>[1], note: string) => void
}) {
  return (
    <div className="admin-setting">
      <label htmlFor="admin-announce">Let the apps find this box on the crew network</label>
      {status.fromEnv ? (
        <p className="admin-note">Set by CREWBOX_ANNOUNCE in the environment; change it there.</p>
      ) : (
        <select
          id="admin-announce"
          value={status.setting}
          disabled={saving}
          onChange={(e) => {
            const announce = e.target.value as api.AnnounceSetting
            onSave(
              { announce },
              announce === 'off'
                ? 'The box has stopped announcing itself'
                : 'Announcement setting saved'
            )
          }}
        >
          <option value="auto">Automatic: not on a show network</option>
          <option value="on">Always, even on a show network</option>
          <option value="off">Never</option>
        </select>
      )}
      <p className="admin-status" role="status">
        {describeAnnounce(status)}
      </p>
    </div>
  )
}

/**
 * Changing the admin password.
 *
 * Not a SettingField, because that one compares against the value the server
 * holds to decide whether Save does anything — and the whole point here is
 * that the server never sends this one back. Blank field, save when it's long
 * enough, blank again afterwards.
 */
function AdminPasswordField({
  fromEnv,
  onNote,
}: {
  fromEnv: boolean
  onNote: (note: string) => void
}) {
  const setAdminToken = useStore((s) => s.setAdminToken)
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)

  if (fromEnv) {
    return (
      <div className="admin-setting">
        <label>Admin password</label>
        <p className="admin-muted">
          Set by <code>ADMIN_PASSWORD</code> in this box&rsquo;s service file, so it can&rsquo;t be
          changed from here. Change it there and restart.
        </p>
      </div>
    )
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    void api
      .adminUpdateSettings(auth(), { adminPassword: value })
      .then(({ adminToken }) => {
        // Every other unlocked device just lost its token; this one gets a
        // replacement so the person who made the change stays in.
        if (adminToken) setAdminToken(adminToken)
        setValue('')
        onNote('Admin password changed — any other device with the panel open is now locked')
      })
      .catch((err) => onNote(adminError(err, 'Save failed')))
      .finally(() => setSaving(false))
  }

  return (
    <form className="admin-setting" onSubmit={submit}>
      <label htmlFor="admin-new-password">Admin password (opens this panel)</label>
      <div className="admin-setting-row">
        <input
          id="admin-new-password"
          type="password"
          value={value}
          disabled={saving}
          minLength={8}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="at least 8 characters"
          onChange={(e) => setValue(e.target.value)}
        />
        <button className="admin-btn" type="submit" disabled={saving || value.trim().length < 8}>
          {saving ? 'Saving…' : 'Change'}
        </button>
      </div>
      <p className="admin-muted">
        Not the event PIN — this one is never shown to crew. Changing it locks every other device
        that had the panel open.
      </p>
    </form>
  )
}

function UserRow({
  user,
  online,
  isMe,
  onNote,
}: {
  user: User
  online: boolean
  isMe: boolean
  onNote: (note: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!PIN_RE.test(pin)) return
    setBusy(true)
    try {
      await api.adminResetPin(auth(), user.id, pin)
      onNote(`PIN reset for ${user.name}`)
      setEditing(false)
      setPin('')
    } catch (err) {
      onNote(adminError(err, 'PIN reset failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="admin-row">
      <span className={`presence-dot ${online ? 'on' : ''}`} />
      <span className="admin-row-name">
        {user.name}
        {isMe && <span className="admin-muted"> (you)</span>}
      </span>
      {user.role === 'admin' && <span className="role-tag">admin</span>}
      <span className="admin-muted">{online ? 'online' : 'offline'}</span>
      {editing ? (
        <form className="admin-inline-form" onSubmit={(e) => void submit(e)}>
          <input
            autoFocus
            inputMode="numeric"
            maxLength={8}
            placeholder="New PIN"
            aria-label={`New PIN for ${user.name}`}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
          />
          <button className="admin-btn" disabled={busy || !PIN_RE.test(pin)}>
            Save
          </button>
        </form>
      ) : (
        <button className="admin-btn" onClick={() => setEditing(true)}>
          Reset PIN
        </button>
      )}
    </li>
  )
}

function ChannelRow({ channel, onNote }: { channel: Channel; onNote: (note: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(channel.name)
  const [topic, setTopic] = useState(channel.topic)
  const [confirmRetire, setConfirmRetire] = useState(false)
  const [busy, setBusy] = useState(false)

  function startEditing() {
    setName(channel.name)
    setTopic(channel.topic)
    setConfirmRetire(false)
    setEditing(true)
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    const nextName = name.trim().toLowerCase().replace(/\s+/g, '-')
    const patch: { name?: string; topic?: string } = {}
    if (nextName && nextName !== channel.name) patch.name = nextName
    if (topic !== channel.topic) patch.topic = topic
    if (!Object.keys(patch).length) {
      setEditing(false)
      return
    }
    setBusy(true)
    try {
      await api.adminUpdateChannel(auth(), channel.id, patch)
      onNote(`#${patch.name ?? channel.name} updated`)
      setEditing(false)
    } catch (err) {
      onNote(adminError(err, 'Channel update failed'))
    } finally {
      setBusy(false)
    }
  }

  async function retire() {
    if (!confirmRetire) {
      setConfirmRetire(true)
      return
    }
    setBusy(true)
    try {
      await api.adminUpdateChannel(auth(), channel.id, { retired: true })
      onNote(`#${channel.name} retired`)
    } catch (err) {
      onNote(adminError(err, 'Retire failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="admin-channel">
      <div className="admin-row">
        <span className="row-hash">#</span>
        <span className="admin-row-name">{channel.name}</span>
        {channel.topic && <span className="admin-muted admin-topic">{channel.topic}</span>}
        <button className="admin-btn" onClick={editing ? () => setEditing(false) : startEditing}>
          {editing ? 'Cancel' : 'Edit'}
        </button>
      </div>
      {editing && (
        <form className="admin-channel-form" onSubmit={(e) => void save(e)}>
          <input
            autoFocus
            value={name}
            maxLength={32}
            placeholder="channel-name"
            aria-label={`Rename #${channel.name}`}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
          />
          <input
            value={topic}
            maxLength={200}
            placeholder="Topic"
            aria-label={`Topic for #${channel.name}`}
            onChange={(e) => setTopic(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
          />
          <div className="admin-channel-actions">
            <button className="admin-btn" disabled={busy}>
              Save
            </button>
            {channel.name !== 'general' && (
              <button
                type="button"
                className={`admin-btn danger ${confirmRetire ? 'confirm' : ''}`}
                disabled={busy}
                onClick={() => void retire()}
              >
                {confirmRetire ? 'Really retire?' : 'Retire'}
              </button>
            )}
          </div>
        </form>
      )}
    </li>
  )
}
