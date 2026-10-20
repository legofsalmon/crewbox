import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { Department, User } from '@crewbox/shared'
import { useStore } from '../store.ts'
import * as api from '../lib/api.ts'
import { adminError } from '../lib/adminerror.ts'
import { crewByDepartment, USUAL_DEPARTMENTS } from '../lib/departments.ts'

const PIN_RE = /^\d{4,8}$/

/** How long a pressed Delete stays armed (design system: `arm`). */
const ARM_MS = 3000

/**
 * Settings → Admin → Crew and Departments: who is an admin, and who is in
 * which department.
 *
 * Both are reversible, so both act at once and say what they did; only
 * deleting a department arms first, because it takes everybody in it out of
 * it and nothing puts them back.
 */
export default function PeopleSection({
  auth,
  onNote,
}: {
  auth: () => api.AdminAuth
  onNote: (note: string) => void
}) {
  const users = useStore((s) => s.users)
  const online = useStore((s) => s.online)
  const departments = useStore((s) => s.departments)
  const me = useStore((s) => s.me)

  const groups = useMemo(
    () => crewByDepartment(Object.values(users), departments, online),
    [users, departments, online]
  )
  const sortedDepartments = useMemo(
    () => Object.values(departments).sort((a, b) => a.name.localeCompare(b.name)),
    [departments]
  )

  return (
    <>
      <section>
        <h3 className="admin-section-title">Crew</h3>
        {me && me.role !== 'admin' && <MakeMeAdmin me={me} auth={auth} onNote={onNote} />}
        {groups.map((group) => (
          <div key={group.id ?? 'none'} className="admin-crew-group">
            {/* Only once there are departments: a single "No department"
                heading over everybody says nothing. */}
            {sortedDepartments.length > 0 && (
              <h4 className="admin-subhead admin-crew-head">
                {group.name ?? 'No department'}
                <span className="admin-muted"> · {group.people.length}</span>
              </h4>
            )}
            <ul>
              {group.people.map((user) => (
                <UserRow
                  key={user.id}
                  user={user}
                  online={!!online[user.id]}
                  isMe={user.id === me?.id}
                  departments={sortedDepartments}
                  auth={auth}
                  onNote={onNote}
                />
              ))}
            </ul>
          </div>
        ))}
      </section>
      <section>
        <h3 className="admin-section-title">Departments</h3>
        <DepartmentsList
          departments={sortedDepartments}
          users={users}
          auth={auth}
          onNote={onNote}
        />
      </section>
    </>
  )
}

/**
 * Said to somebody who opened the panel with the box's password or link and
 * is not an admin themselves: the one step that makes the next time their
 * own PIN. Asked after the panel has opened, not before (Reciprocity).
 */
function MakeMeAdmin({
  me,
  auth,
  onNote,
}: {
  me: User
  auth: () => api.AdminAuth
  onNote: (note: string) => void
}) {
  const [busy, setBusy] = useState(false)

  async function promote() {
    setBusy(true)
    try {
      await api.adminUpdateUser(auth(), me.id, { role: 'admin' })
      onNote('You’re an admin. Next time, your own PIN opens this tab.')
    } catch (err) {
      onNote(adminError(err, 'Could not make you an admin'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="admin-row admin-make-me">
      <span className="admin-help">
        You opened this with the box’s password. Make yourself an admin and your own PIN opens it
        next time.
      </span>
      <button className="admin-btn" disabled={busy} onClick={() => void promote()}>
        Make me an admin
      </button>
    </div>
  )
}

function UserRow({
  user,
  online,
  isMe,
  departments,
  auth,
  onNote,
}: {
  user: User
  online: boolean
  isMe: boolean
  departments: Department[]
  auth: () => api.AdminAuth
  onNote: (note: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const admin = user.role === 'admin'

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

  async function toggleAdmin() {
    setBusy(true)
    try {
      await api.adminUpdateUser(auth(), user.id, { role: admin ? 'member' : 'admin' })
      onNote(
        admin
          ? isMe
            ? 'You’re no longer an admin. The box’s password still opens this tab.'
            : `${user.name} is no longer an admin.`
          : `${user.name} is an admin. Their own PIN opens this tab.`
      )
    } catch (err) {
      onNote(adminError(err, 'Could not change that'))
    } finally {
      setBusy(false)
    }
  }

  async function move(departmentId: string) {
    setBusy(true)
    try {
      await api.adminUpdateUser(auth(), user.id, { departmentId: departmentId || null })
      const department = departments.find((d) => d.id === departmentId)
      onNote(
        department ? `${user.name} is in ${department.name}.` : `${user.name} is in no department.`
      )
    } catch (err) {
      onNote(adminError(err, 'Could not move them'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="admin-row admin-person">
      <span className="admin-person-who">
        <span className={`presence-dot ${online ? 'on' : ''}`} />
        <span className="admin-row-name">
          {user.name}
          {isMe && <span className="admin-muted"> (you)</span>}
        </span>
        {admin && <span className="role-tag">admin</span>}
        <span className="admin-muted">{online ? 'online' : 'offline'}</span>
      </span>
      <span className="admin-person-actions">
        {departments.length > 0 && (
          <select
            aria-label={`Department for ${user.name}`}
            value={user.departmentId ?? ''}
            disabled={busy}
            onChange={(e) => void move(e.target.value)}
          >
            <option value="">No department</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        )}
        <button
          className="admin-btn"
          disabled={busy}
          aria-pressed={admin}
          title={admin ? 'Admin: press to take it away' : 'Not an admin: press to make them one'}
          onClick={() => void toggleAdmin()}
        >
          {admin ? 'Remove admin' : 'Make admin'}
        </button>
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
              Save PIN
            </button>
          </form>
        ) : (
          <button className="admin-btn" onClick={() => setEditing(true)}>
            Reset PIN
          </button>
        )}
      </span>
    </li>
  )
}

function DepartmentsList({
  departments,
  users,
  auth,
  onNote,
}: {
  departments: Department[]
  users: Record<string, User>
  auth: () => api.AdminAuth
  onNote: (note: string) => void
}) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const counts = useMemo(() => {
    const byId: Record<string, number> = {}
    for (const user of Object.values(users)) {
      if (user.departmentId) byId[user.departmentId] = (byId[user.departmentId] ?? 0) + 1
    }
    return byId
  }, [users])

  async function add(e: FormEvent) {
    e.preventDefault()
    const typed = name.trim()
    if (!typed) return
    setBusy(true)
    setError(null)
    try {
      await api.adminCreateDepartment(auth(), typed)
      onNote(`${typed} added. Crew can pick it under Settings → General.`)
      setName('')
    } catch (err) {
      // Next to the field, keeping what was typed (rule 18).
      setError(adminError(err, 'Could not add it'))
    } finally {
      setBusy(false)
    }
  }

  async function addUsual() {
    setBusy(true)
    setError(null)
    try {
      for (const usual of USUAL_DEPARTMENTS) await api.adminCreateDepartment(auth(), usual)
      onNote(`${USUAL_DEPARTMENTS.join(', ')} added. Rename or delete any that don’t fit.`)
    } catch (err) {
      setError(adminError(err, 'Could not add them all'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {departments.length === 0 ? (
        <div className="admin-empty">
          <p className="admin-help">
            No departments yet. Once there are, crew pick theirs in Settings, the crew list groups
            by them, and <strong>@Lighting</strong> reaches everyone in Lighting.
          </p>
          <button className="admin-btn" disabled={busy} onClick={() => void addUsual()}>
            Add {USUAL_DEPARTMENTS.join(', ')}
          </button>
        </div>
      ) : (
        <ul>
          {departments.map((department) => (
            <DepartmentRow
              key={department.id}
              department={department}
              count={counts[department.id] ?? 0}
              auth={auth}
              onNote={onNote}
            />
          ))}
        </ul>
      )}
      <form className="admin-row admin-department-add" onSubmit={(e) => void add(e)}>
        <input
          value={name}
          maxLength={32}
          placeholder="e.g. Rigging"
          aria-label="New department"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'admin-department-error' : undefined}
          onChange={(e) => setName(e.target.value)}
        />
        <button className="admin-btn" disabled={busy || !name.trim()}>
          Add department
        </button>
      </form>
      {error && (
        <p className="admin-error admin-department-error" id="admin-department-error" role="alert">
          {error}
        </p>
      )}
    </>
  )
}

function DepartmentRow({
  department,
  count,
  auth,
  onNote,
}: {
  department: Department
  count: number
  auth: () => api.AdminAuth
  onNote: (note: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(department.name)
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)

  // An armed Delete waits `arm`, then lets go on its own.
  useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(false), ARM_MS)
    return () => clearTimeout(timer)
  }, [armed])

  async function rename(e: FormEvent) {
    e.preventDefault()
    const typed = name.trim()
    if (!typed || typed === department.name) {
      setEditing(false)
      return
    }
    setBusy(true)
    try {
      await api.adminRenameDepartment(auth(), department.id, typed)
      onNote(`${department.name} is now ${typed}. @${typed} reaches them from now on.`)
      setEditing(false)
    } catch (err) {
      onNote(adminError(err, 'Could not rename it'))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!armed) {
      setArmed(true)
      return
    }
    setBusy(true)
    try {
      await api.adminDeleteDepartment(auth(), department.id)
      onNote(
        count
          ? `${department.name} deleted. ${count === 1 ? 'The person' : `The ${count} people`} in it are in no department now.`
          : `${department.name} deleted.`
      )
    } catch (err) {
      onNote(adminError(err, 'Could not delete it'))
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <li>
        <form className="admin-row admin-department-add" onSubmit={(e) => void rename(e)}>
          <input
            autoFocus
            value={name}
            maxLength={32}
            aria-label={`Rename ${department.name}`}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
          />
          <button className="admin-btn" disabled={busy}>
            Save
          </button>
          <button type="button" className="admin-btn" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </form>
      </li>
    )
  }

  return (
    <li className="admin-row admin-department">
      <span className="admin-row-name">{department.name}</span>
      <span className="admin-muted admin-topic">
        {count === 1 ? '1 person' : `${count} people`}
      </span>
      <button
        className="admin-btn"
        onClick={() => {
          setName(department.name)
          setEditing(true)
        }}
      >
        Rename
      </button>
      <button
        className={`admin-btn danger ${armed ? 'confirm' : ''}`}
        disabled={busy}
        onClick={() => void remove()}
        onBlur={() => setArmed(false)}
      >
        {armed ? `Delete ${department.name}?` : 'Delete'}
      </button>
    </li>
  )
}
