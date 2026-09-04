import { describe, expect, it } from 'vitest'
import { draftKey } from './useDraft.ts'

/**
 * Typing Japanese, Chinese or Korean goes through a candidate window that
 * Enter *selects* from and Escape *cancels*. Acting on those took the
 * unconfirmed reading, blurred the field, and left a crew member's name
 * half-transliterated in a document every other device on the box is
 * watching — or threw away a word mid-conversion.
 */

describe('what a key press in a draft field means', () => {
  it('nothing at all, while an input method is composing', () => {
    expect(draftKey('Enter', { composing: true })).toBe('ignore')
    expect(draftKey('Escape', { composing: true })).toBe('ignore')
  })

  it('commit on an ordinary Enter', () => {
    expect(draftKey('Enter', { composing: false })).toBe('commit')
  })

  it('a newline in a multiline field, which is not a commit', () => {
    // Spec and notes boxes: Enter is a paragraph break and blur is the
    // commit.
    expect(draftKey('Enter', { composing: false, multiline: true })).toBe('ignore')
  })

  it('revert on Escape', () => {
    expect(draftKey('Escape', { composing: false })).toBe('revert')
    // Including in a multiline field: abandoning a note is still abandoning.
    expect(draftKey('Escape', { composing: false, multiline: true })).toBe('revert')
  })

  it('nothing for every other key', () => {
    expect(draftKey('a', { composing: false })).toBe('ignore')
    expect(draftKey('Tab', { composing: false })).toBe('ignore')
  })
})
