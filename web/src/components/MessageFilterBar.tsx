import { useMemo } from 'react'
import { useStore } from '../store.ts'
import {
  isFiltering,
  matchesFilter,
  type MessageFilter,
  type MessageKindFilter,
} from '../lib/messageFilter.ts'

const KINDS: Array<{ id: MessageKindFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'media', label: 'Photos' },
  { id: 'files', label: 'Files' },
  { id: 'links', label: 'Links' },
  { id: 'mentions', label: 'Mentions' },
]

/**
 * Narrow a channel's transcript to one person, or to just the photos, files,
 * links or mentions.
 *
 * The honest bit is the count line. This filters the messages the phone has
 * actually loaded — a channel's history lives on the box and the client keeps
 * a tail of it — so the bar says how many that is and offers to pull in more
 * rather than quietly implying it searched everything. Full-history search is
 * the magnifying glass in the header; this is for skimming what's in front of
 * you, which is what someone squinting at a phone on a loading dock wants.
 */
export default function MessageFilterBar({
  channelId,
  filter,
  onChange,
}: {
  channelId: string
  filter: MessageFilter
  onChange: (filter: MessageFilter) => void
}) {
  const messages = useStore((s) => s.messages[channelId])
  const users = useStore((s) => s.users)
  const me = useStore((s) => s.me)
  const loadOlder = useStore((s) => s.loadOlder)
  const loadingOlder = useStore((s) => s.loadingOlder)

  const list = useMemo(() => messages ?? [], [messages])

  // Only people who have actually said something here. A box can carry a
  // hundred accounts across a festival; the crew of this channel is what you
  // want to pick from.
  const authors = useMemo(() => {
    const seen = new Map<string, string>()
    for (const msg of list) {
      if (msg.kind === 'system' || !msg.authorId) continue
      if (!seen.has(msg.authorId)) seen.set(msg.authorId, users[msg.authorId]?.name ?? 'Unknown')
    }
    return [...seen]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [list, users])

  const hasOlder = list.length > 0 && (list[0]?.seq ?? 1) > 1
  const active = isFiltering(filter)
  // Counted here rather than reported up from the transcript: both run the one
  // `matchesFilter`, so there is nothing to drift, and a child telling its
  // parent a count during render is the kind of loop that bites later.
  const matched = useMemo(
    () => (active ? list.filter((m) => matchesFilter(m, filter, me?.name)).length : list.length),
    [active, list, filter, me?.name]
  )

  return (
    <div className="filter-bar" role="group" aria-label="Filter messages">
      <div className="filter-row">
        <select
          className="filter-author"
          aria-label="Filter by person"
          value={filter.authorId ?? ''}
          onChange={(e) => onChange({ ...filter, authorId: e.target.value || null })}
        >
          <option value="">Everyone</option>
          {authors.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <div className="filter-note">
          <span>
            {active
              ? `${matched} of ${list.length} loaded`
              : `${list.length} ${list.length === 1 ? 'message' : 'messages'} loaded`}
          </span>
          {hasOlder && (
            <button
              type="button"
              className="filter-more"
              disabled={loadingOlder}
              onClick={() => void loadOlder(channelId)}
            >
              {loadingOlder ? 'Loading…' : 'Load older'}
            </button>
          )}
          {active && (
            <button
              type="button"
              className="filter-clear"
              onClick={() => onChange({ authorId: null, kind: 'all' })}
            >
              Clear
            </button>
          )}
        </div>
      </div>
      {/* Own row, so a phone shows the whole set. Sharing a row with the
          person picker pushed "All" off the left edge, and a filter you can
          see no way out of is worse than no filter. */}
      <div className="filter-kinds">
        {KINDS.map((kind) => (
          <button
            key={kind.id}
            type="button"
            className={`filter-chip ${filter.kind === kind.id ? 'on' : ''}`}
            aria-pressed={filter.kind === kind.id}
            onClick={() => onChange({ ...filter, kind: kind.id })}
          >
            {kind.label}
          </button>
        ))}
      </div>
    </div>
  )
}
