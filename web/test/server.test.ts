import { beforeEach, describe, expect, it } from 'vitest'
import {
  absoluteFileUrl,
  apiUrl,
  normalizeOrigin,
  serverLabel,
  serverOrigin,
  setServerOrigin,
  wsUrl,
} from '../src/lib/server.ts'

// Minimal browser globals for the node test environment.
const backing = new Map<string, string>()
beforeEach(() => {
  backing.clear()
  globalThis.localStorage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
    clear: () => backing.clear(),
    key: () => null,
    length: 0,
  } as Storage
  ;(globalThis as Record<string, unknown>).location = {
    protocol: 'https:',
    host: 'chat.crew.example',
    origin: 'https://chat.crew.example',
  }
})

describe('normalizeOrigin', () => {
  it('adds http:// when no scheme is given (LAN default)', () => {
    expect(normalizeOrigin('192.168.8.1')).toBe('http://192.168.8.1')
    expect(normalizeOrigin('chat.crew.example:8787')).toBe('http://chat.crew.example:8787')
  })

  it('keeps explicit schemes and strips paths/slashes', () => {
    expect(normalizeOrigin('https://chat.crew.example/')).toBe('https://chat.crew.example')
    expect(normalizeOrigin('http://192.168.8.1/join?x=1')).toBe('http://192.168.8.1')
  })

  it('returns empty for blank or hopeless input', () => {
    expect(normalizeOrigin('')).toBe('')
    expect(normalizeOrigin('   ')).toBe('')
    expect(normalizeOrigin('http://')).toBe('')
  })
})

describe('same-origin default (the PWA path)', () => {
  it('leaves API paths relative and derives ws from location', () => {
    expect(serverOrigin()).toBe('')
    expect(apiUrl('/api/join')).toBe('/api/join')
    expect(wsUrl()).toBe('wss://chat.crew.example/ws')
    expect(serverLabel()).toBe('chat.crew.example')
    expect(absoluteFileUrl({ id: 'f1', name: 'map.png', mime: 'image/png', size: 1 })).toBe(
      'https://chat.crew.example/api/files/f1/map.png',
    )
  })
})

describe('configured origin (the native path)', () => {
  it('prefixes API, WS, file and label URLs', () => {
    setServerOrigin('192.168.8.1:8787')
    expect(serverOrigin()).toBe('http://192.168.8.1:8787')
    expect(apiUrl('/api/join')).toBe('http://192.168.8.1:8787/api/join')
    expect(wsUrl()).toBe('ws://192.168.8.1:8787/ws')
    expect(serverLabel()).toBe('192.168.8.1:8787')
    expect(absoluteFileUrl({ id: 'f1', name: 'map.png', mime: 'image/png', size: 1 })).toBe(
      'http://192.168.8.1:8787/api/files/f1/map.png',
    )
  })

  it('https origins get wss', () => {
    setServerOrigin('https://chat.crew.example')
    expect(wsUrl()).toBe('wss://chat.crew.example/ws')
  })

  it('clearing restores same-origin behaviour', () => {
    setServerOrigin('192.168.8.1')
    setServerOrigin('')
    expect(serverOrigin()).toBe('')
    expect(apiUrl('/api/config')).toBe('/api/config')
  })
})
