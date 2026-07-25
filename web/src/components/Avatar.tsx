interface Props {
  name: string
  id: string
  size?: number
}

function hue(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360
  return h
}

export default function Avatar({ name, id, size = 36 }: Props) {
  const initials = name
    .split(/\s+/)
    .map((part) => part.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('')
  return (
    <span
      className="avatar"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        background: `hsl(${hue(id)} 45% 38%)`,
      }}
    >
      {initials || '?'}
    </span>
  )
}
