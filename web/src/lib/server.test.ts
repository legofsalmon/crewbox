import { describe, expect, it } from 'vitest'
import { iphoneRefusesPlainHttp, normalizeOrigin } from './server.ts'

/**
 * What the iPhone app's App Transport Security exemption lets through on
 * plain HTTP: IP addresses, `.local` names and names with no dot
 * (NSAllowsLocalNetworking, per Apple's documentation of the key).
 */
describe('which box addresses the iPhone refuses on plain HTTP', () => {
  it.each([
    ['http://192.168.8.1:3000', 'an IPv4 address'],
    ['http://10.0.0.5', 'another IPv4 address'],
    ['http://[fe80::1]:3000', 'an IPv6 address'],
    ['http://crewbox.local:3000', 'a .local name'],
    ['http://crewbox:3000', 'a name with no dot'],
    ['http://localhost:4299', 'localhost'],
    ['https://chat.crew.example', 'any name over HTTPS'],
    ['https://chat.crew.example:3443', 'a name over HTTPS on its own port'],
  ])('lets %s through: %s', (origin) => {
    expect(iphoneRefusesPlainHttp(origin)).toBe(false)
  })

  it.each([
    ['http://chat.crew.example', 'a name on the public DNS shape'],
    ['http://crewbox.lan:3000', 'a router-given name'],
    ['http://crewbox.fritz.box', 'a router-given name, two dots'],
  ])('refuses %s: %s', (origin) => {
    expect(iphoneRefusesPlainHttp(origin)).toBe(true)
  })

  it('refuses a name typed without a scheme, which the field makes plain HTTP', () => {
    expect(iphoneRefusesPlainHttp(normalizeOrigin('chat.crew.example'))).toBe(true)
    expect(iphoneRefusesPlainHttp(normalizeOrigin('192.168.8.1:3000'))).toBe(false)
  })

  it('has nothing to say about an address that is not one', () => {
    expect(iphoneRefusesPlainHttp('')).toBe(false)
    expect(iphoneRefusesPlainHttp('not a url')).toBe(false)
  })
})
