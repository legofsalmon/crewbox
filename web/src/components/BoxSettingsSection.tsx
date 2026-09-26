import { useEffect, useState, type ReactNode } from 'react'
import * as api from '../lib/api.ts'
import { adminError } from '../lib/adminerror.ts'
import { adapterMissing } from '../lib/adminnetwork.ts'
import { changesFrom, formFrom, moduleIds, type BoxForm } from '../lib/boxsettings.ts'
import { allModules } from '../shell/registry.ts'

/** Timezone names for the field's suggestions, where the browser can list them. */
const TIME_ZONES: string[] = (() => {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
  try {
    return intl.supportedValuesOf?.('timeZone') ?? []
  } catch {
    return []
  }
})()

const titleOf = (id: string): string => allModules.find((m) => m.id === id)?.title ?? id

/**
 * Settings that used to be environment variables, and nothing else — the
 * event, the PIN and the networks have their own sections above. Each is
 * read when the box starts, so a save says "restart to apply" and means it.
 *
 * A setting the environment pins is shown, not offered: the environment
 * wins, so a field for it would save something that never takes effect.
 */
export default function BoxSettingsSection({
  auth,
  onNote,
  locked,
}: {
  auth: () => api.AdminAuth
  onNote: (note: string) => void
  locked: boolean
}) {
  const [data, setData] = useState<api.BoxSettings | null>(null)
  const [form, setForm] = useState<BoxForm | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let live = true
    api
      .adminGetBoxSettings(auth())
      .then((loaded) => {
        if (!live) return
        setData(loaded)
        setForm(formFrom(loaded))
      })
      .catch((err: unknown) => {
        // An older box has no such route; the section simply isn't there.
        if (live && !(err instanceof api.ApiError && err.status === 404)) {
          onNote(adminError(err, 'Could not load the box settings'))
        }
      })
    return () => {
      live = false
    }
  }, [auth, onNote])

  if (!data || !form) return null

  const initial = formFrom(data)
  const changes = changesFrom(data, initial, form)
  const dirty = Object.keys(changes).length > 0
  const set = (name: api.BoxSettingName, value: string) => setForm({ ...form, [name]: value })
  const pinned = (name: api.BoxSettingName): boolean => data.settings[name]?.fromEnv ?? false

  /** A labelled field, or the note that the environment decides it. */
  const field = (name: api.BoxSettingName, label: string, control: ReactNode, help?: string) => (
    <>
      <label htmlFor={`box-${name}`}>{label}</label>
      {pinned(name) ? (
        <p className="admin-note">
          Set by {name}
          {data.settings[name]?.boot ? `=${data.settings[name]?.boot}` : ''} in the box’s
          environment, which wins. Change it there, or remove it to choose here.
        </p>
      ) : (
        control
      )}
      {help && <p className="admin-help">{help}</p>}
    </>
  )

  const adapterSelect = (name: api.BoxSettingName, none: string) => (
    <select id={`box-${name}`} value={form[name]} onChange={(e) => set(name, e.target.value)}>
      <option value="">{none}</option>
      {data.adapters.map((a) => (
        <option key={a.address} value={a.address}>
          {a.name} — {a.address}
        </option>
      ))}
      {adapterMissing(data.adapters, form[name]) && (
        <option value={form[name]}>{form[name]} — not connected</option>
      )}
    </select>
  )

  const onOffAuto = (name: api.BoxSettingName, auto: string) => (
    <select id={`box-${name}`} value={form[name]} onChange={(e) => set(name, e.target.value)}>
      <option value="">{auto}</option>
      <option value="1">On</option>
      <option value="0">Off</option>
    </select>
  )

  const ticked = new Set(moduleIds(form.CREWBOX_MODULES))
  const toggleModule = (id: string, on: boolean) => {
    const next = data.modules.filter((m) => (m === id ? on : ticked.has(m)))
    set('CREWBOX_MODULES', next.join(','))
  }

  async function save() {
    setSaving(true)
    try {
      const saved = await api.adminUpdateBoxSettings(auth(), changes)
      setData(saved)
      setForm(formFrom(saved))
      onNote(
        saved.restartNeeded
          ? 'Box settings saved. Restart the box to apply them.'
          : 'Box settings saved.'
      )
    } catch (err) {
      onNote(adminError(err, 'Could not save the box settings'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      className="admin-networks"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <p className="admin-hint">
        These are read when the box starts. On a Mac or Windows box, restart it from the menu bar
        or tray icon after saving.
      </p>
      {data.restartNeeded && (
        <p className="admin-note">
          Saved settings differ from what this box started with — restart it to apply them.
        </p>
      )}

      <h3 className="admin-subhead">Departments</h3>
      {pinned('CREWBOX_MODULES') ? (
        field('CREWBOX_MODULES', 'Modules', null)
      ) : (
        <fieldset className="admin-checks">
          <legend>Modules crew see (Chat is always on)</legend>
          {data.modules.map((id) => (
            <label key={id} className="admin-check">
              <input
                type="checkbox"
                checked={ticked.has(id)}
                onChange={(e) => toggleModule(id, e.target.checked)}
              />
              {titleOf(id)}
            </label>
          ))}
        </fieldset>
      )}
      {field(
        'CREWBOX_TZ',
        'Festival timezone',
        <>
          <input
            id="box-CREWBOX_TZ"
            list="box-tz-list"
            value={form.CREWBOX_TZ}
            placeholder="The box’s own clock"
            maxLength={64}
            onChange={(e) => set('CREWBOX_TZ', e.target.value)}
          />
          <datalist id="box-tz-list">
            {TIME_ZONES.map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
        </>,
        'Where the show is, like Europe/Dublin. The running order and show log read times on this clock. Leave blank when the box’s clock is already set to local time.'
      )}

      <h3 className="admin-subhead">Lighting</h3>
      {field(
        'CREWBOX_DMX_ARTNET_BASE',
        'Art-Net universe 0 is',
        <select
          id="box-CREWBOX_DMX_ARTNET_BASE"
          value={form.CREWBOX_DMX_ARTNET_BASE}
          onChange={(e) => set('CREWBOX_DMX_ARTNET_BASE', e.target.value)}
        >
          <option value="">Plot universe 1 (usual)</option>
          <option value="0">Plot universe 0</option>
        </select>,
        'Art-Net counts universes from 0 and most plots count from 1. Get this wrong and every fixture is checked against the wrong universe.'
      )}

      <h3 className="admin-subhead">Audio and media network</h3>
      {field(
        'CREWBOX_WATCH',
        'Watch the media network',
        <select
          id="box-CREWBOX_WATCH"
          value={form.CREWBOX_WATCH}
          onChange={(e) => set('CREWBOX_WATCH', e.target.value)}
        >
          <option value="">Off</option>
          <option value="1">On</option>
        </select>,
        'Listens for the PTP clock, Dante and NDI devices and AES67 streams. It only listens; it never sends on that network.'
      )}
      {(form.CREWBOX_WATCH === '1' || pinned('CREWBOX_WATCH')) &&
        field(
          'CREWBOX_WATCH_IFACE',
          'Media network adapter',
          adapterSelect('CREWBOX_WATCH_IFACE', 'Let the computer choose')
        )}

      <h3 className="admin-subhead">Video</h3>
      {field(
        'CREWBOX_VIDEO_IFACE',
        'Video network adapter',
        adapterSelect('CREWBOX_VIDEO_IFACE', 'None: add processors by address'),
        'Needed only to sweep for LED processors. Processors added by address are read without it.'
      )}
      {field(
        'CREWBOX_VIDEO_SNMP_COMMUNITY',
        'SNMP community',
        <input
          id="box-CREWBOX_VIDEO_SNMP_COMMUNITY"
          value={form.CREWBOX_VIDEO_SNMP_COMMUNITY}
          placeholder="public"
          maxLength={32}
          onChange={(e) => set('CREWBOX_VIDEO_SNMP_COMMUNITY', e.target.value)}
        />,
        'Leave as public unless the venue has changed it.'
      )}

      <h3 className="admin-subhead">Internet and phones</h3>
      {field(
        'CREWBOX_UPDATE_CHECK',
        'Use the internet when there is some',
        onOffAuto('CREWBOX_UPDATE_CHECK', 'Automatic (on for a box)'),
        'Checking for updates, sending crash reports you allow, and licence check-ins. Off, the box makes no outbound connections at all.'
      )}
      {field(
        'CREWBOX_CAPTIVE',
        'Answer phones’ internet checks',
        onOffAuto('CREWBOX_CAPTIVE', 'Automatic (on for a box)'),
        'Keeps iPhones and Androids on a crew Wi-Fi with no internet. Needs the router DNS file from This network.'
      )}
      {field(
        'CREWBOX_CAPTIVE_PORT',
        'Port for those checks',
        <input
          id="box-CREWBOX_CAPTIVE_PORT"
          value={form.CREWBOX_CAPTIVE_PORT}
          inputMode="numeric"
          placeholder="80, or 8880 when 80 is taken"
          maxLength={5}
          onChange={(e) => set('CREWBOX_CAPTIVE_PORT', e.target.value)}
        />,
        'Leave blank unless you have set up a redirect to a particular port.'
      )}
      {field(
        'SESSION_TTL_DAYS',
        'Keep crew signed in for (days)',
        <input
          id="box-SESSION_TTL_DAYS"
          value={form.SESSION_TTL_DAYS}
          inputMode="numeric"
          placeholder="60"
          maxLength={4}
          onChange={(e) => set('SESSION_TTL_DAYS', e.target.value)}
        />,
        'A phone unused for longer than this has to join again.'
      )}

      <button className="admin-btn" type="submit" disabled={locked || saving || !dirty}>
        {saving ? 'Saving…' : 'Save box settings'}
      </button>
    </form>
  )
}
