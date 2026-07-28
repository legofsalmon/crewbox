import { describe, expect, it } from 'vitest'
import type { Message } from '@crewbox/shared'
import {
  hasLink,
  hrefFor,
  matchesFilter,
  mentionsMe,
  splitLinks,
  trimUrl,
  NO_FILTER,
} from './messageFilter'

const msg = (over: Partial<Message> = {}): Message => ({
  id: 'm1',
  channelId: 'c1',
  seq: 1,
  authorId: 'u1',
  kind: 'text',
  body: '',
  createdAt: 0,
  ...over,
})

const file = (mime: string) => ({ id: 'f', name: 'x', mime, size: 1 })

describe('link detection', () => {
  it('finds plain and bare-www addresses', () => {
    expect(hasLink('see https://example.com for it')).toBe(true)
    expect(hasLink('www.example.com')).toBe(true)
    expect(hasLink('no address here')).toBe(false)
  })

  it('does not eat the full stop that ended the sentence', () => {
    // Crew paste an address mid-sentence constantly; a link that swallows the
    // punctuation is a link that 404s.
    expect(trimUrl('https://example.com/plan.')).toBe('https://example.com/plan')
    expect(trimUrl('https://example.com/a,')).toBe('https://example.com/a')
    expect(trimUrl('https://example.com/a')).toBe('https://example.com/a')
  })

  it('keeps a trailing dot as text rather than dropping it', () => {
    const parts = splitLinks('go to https://example.com.')
    expect(parts).toEqual([
      { text: 'go to ' },
      { text: 'https://example.com', url: 'https://example.com' },
      { text: '.' },
    ])
  })

  it('gives a bare www address a scheme', () => {
    // Without one the browser resolves it as a path inside this app, so the
    // link would navigate into the box instead of out to the web.
    expect(hrefFor('www.example.com')).toBe('https://www.example.com')
    expect(hrefFor('http://example.com')).toBe('http://example.com')
  })

  it('leaves text with no links as a single part', () => {
    expect(splitLinks('nothing here')).toEqual([{ text: 'nothing here' }])
  })

  it('handles several links in one message', () => {
    const parts = splitLinks('a https://one.com b https://two.com')
    expect(parts.filter((p) => p.url).map((p) => p.url)).toEqual([
      'https://one.com',
      'https://two.com',
    ])
  })
})

describe('mentions', () => {
  it('matches my name and the broadcast forms', () => {
    expect(mentionsMe('hey @Dave can you', 'Dave')).toBe(true)
    expect(mentionsMe('@ALL doors in 5', 'Dave')).toBe(true)
    expect(mentionsMe('@everyone', undefined)).toBe(true)
    expect(mentionsMe('hey @Sam', 'Dave')).toBe(false)
  })
})

describe('filtering', () => {
  it('keeps everything when nothing is set', () => {
    expect(matchesFilter(msg({ body: 'hi' }), NO_FILTER, 'Dave')).toBe(true)
  })

  it('narrows to one author', () => {
    const f = { authorId: 'u2', kind: 'all' as const }
    expect(matchesFilter(msg({ authorId: 'u2' }), f, 'Dave')).toBe(true)
    expect(matchesFilter(msg({ authorId: 'u1' }), f, 'Dave')).toBe(false)
  })

  it('separates media from other attachments', () => {
    const media = { authorId: null, kind: 'media' as const }
    const files = { authorId: null, kind: 'files' as const }
    const photo = msg({ kind: 'file', file: file('image/jpeg') })
    const pdf = msg({ kind: 'file', file: file('application/pdf') })

    expect(matchesFilter(photo, media, 'Dave')).toBe(true)
    expect(matchesFilter(pdf, media, 'Dave')).toBe(false)
    // Files is the wider net: a patch sheet PDF is an attachment too.
    expect(matchesFilter(pdf, files, 'Dave')).toBe(true)
    expect(matchesFilter(photo, files, 'Dave')).toBe(true)
  })

  it('combines author and kind', () => {
    const f = { authorId: 'u2', kind: 'media' as const }
    expect(matchesFilter(msg({ authorId: 'u2', file: file('image/png') }), f, 'Dave')).toBe(true)
    expect(matchesFilter(msg({ authorId: 'u1', file: file('image/png') }), f, 'Dave')).toBe(false)
  })

  it('hides system messages while filtering, keeps them otherwise', () => {
    // "X joined the channel" is the channel talking about itself. Leaving it
    // in a filtered view makes the filter look broken.
    const system = msg({ kind: 'system', authorId: null, body: 'Dave joined' })
    expect(matchesFilter(system, NO_FILTER, 'Dave')).toBe(true)
    expect(matchesFilter(system, { authorId: null, kind: 'links' }, 'Dave')).toBe(false)
  })
})
