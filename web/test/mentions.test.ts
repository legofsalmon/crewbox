import { describe, expect, it } from 'vitest'
import { isMentioned } from '../src/lib/alerts.ts'

describe('isMentioned', () => {
  it('matches a real @mention of the user', () => {
    expect(isMentioned('hey @Sam can you check gate 3', 'Sam')).toBe(true)
    expect(isMentioned('@Sam', 'Sam')).toBe(true)
    expect(isMentioned('ping @Sam.', 'Sam')).toBe(true) // punctuation boundary
  })

  it('does not fire on a longer name that starts with the user name', () => {
    expect(isMentioned('@Sammy meet me at gate 3', 'Sam')).toBe(false)
    expect(isMentioned('@Eddie is here', 'Ed')).toBe(false)
  })

  it('handles names with regex metacharacters', () => {
    expect(isMentioned('radios for @Alex (Stage 2) please', 'Alex (Stage 2)')).toBe(true)
    // A metachar-escaped name must match literally, not as a pattern.
    expect(isMentioned('@Alex XStage 2Y', 'Alex (Stage 2)')).toBe(false)
  })

  it('matches broadcast mentions regardless of name', () => {
    expect(isMentioned('heads up @all', undefined)).toBe(true)
    expect(isMentioned('@everyone gather', 'Sam')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isMentioned('yo @sam', 'Sam')).toBe(true)
  })
})
