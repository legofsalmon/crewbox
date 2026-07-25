import { describe, expect, it } from 'vitest'
import { parseRoute, routePath, type Route } from '../src/shell/router.ts'

describe('parseRoute', () => {
  it('maps / to home', () => {
    expect(parseRoute('/')).toEqual({ kind: 'home' })
  })

  it('parses channel routes', () => {
    expect(parseRoute('/c/abc123')).toEqual({ kind: 'channel', channelId: 'abc123' })
  })

  it('parses module routes with and without a subpath', () => {
    expect(parseRoute('/m/patch')).toEqual({ kind: 'module', moduleId: 'patch', subpath: '' })
    expect(parseRoute('/m/patch/sheet/s1')).toEqual({
      kind: 'module',
      moduleId: 'patch',
      subpath: 'sheet/s1',
    })
  })

  it('decodes encoded segments', () => {
    expect(parseRoute('/c/dm%3Aa%3Ab')).toEqual({ kind: 'channel', channelId: 'dm:a:b' })
  })

  it('falls back to home on unknown or truncated paths', () => {
    expect(parseRoute('/nope')).toEqual({ kind: 'home' })
    expect(parseRoute('/c')).toEqual({ kind: 'home' })
    expect(parseRoute('/m')).toEqual({ kind: 'home' })
    expect(parseRoute('')).toEqual({ kind: 'home' })
  })
})

describe('routePath', () => {
  it('is the inverse of parseRoute', () => {
    const routes: Route[] = [
      { kind: 'home' },
      { kind: 'channel', channelId: 'abc123' },
      { kind: 'channel', channelId: 'dm:a:b' },
      { kind: 'module', moduleId: 'patch', subpath: '' },
      { kind: 'module', moduleId: 'patch', subpath: 'sheet/s1' },
    ]
    for (const route of routes) {
      expect(parseRoute(routePath(route))).toEqual(route)
    }
  })

  it('percent-encodes unsafe characters', () => {
    expect(routePath({ kind: 'channel', channelId: 'a/b' })).toBe('/c/a%2Fb')
  })
})
