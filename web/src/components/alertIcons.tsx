/** The bell, in the channel header's stroke style: on, for mentions only, or muted. */
export function BellIcon({ level }: { level: 'all' | 'mentions' | 'muted' | 'follow' | 'off' }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      aria-hidden
      fill={level === 'all' || level === 'follow' ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" />
      {(level === 'muted' || level === 'off') && <path d="M3 3l18 18" />}
      {level === 'mentions' && <path d="M12 7v4M12 13.5v.5" />}
    </svg>
  )
}
