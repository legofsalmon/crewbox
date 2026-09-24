import { describe, expect, it } from 'vitest'
import { androidJoinLink, joinLink, readJoinCode, readJoinLink } from './joinCode.ts'

describe('a box’s join QR', () => {
  it('is its address and the event PIN, as /connect prints it on the local network', () => {
    expect(readJoinCode('http://192.168.8.1/?pin=4821')).toEqual({
      kind: 'join',
      origin: 'http://192.168.8.1',
      pin: '4821',
    })
  })

  it('keeps a port, and a name the box has a certificate for', () => {
    expect(readJoinCode('http://10.0.0.2:3000/?pin=4821')).toMatchObject({
      origin: 'http://10.0.0.2:3000',
    })
    expect(readJoinCode('https://Chat.Crew.Example/?pin=a%20b')).toEqual({
      kind: 'join',
      origin: 'https://chat.crew.example',
      pin: 'a b',
    })
  })

  it('has no PIN when read off the local network', () => {
    expect(readJoinCode('https://chat.crew.example/')).toEqual({
      kind: 'join',
      origin: 'https://chat.crew.example',
      pin: '',
    })
    expect(readJoinCode(' http://192.168.8.1 \n')).toMatchObject({ kind: 'join', pin: '' })
  })

  it('is only ever the bare address', () => {
    for (const text of [
      'https://example.com/menu',
      'http://192.168.8.1/admin?pin=4821',
      'http://192.168.8.1/?pin=4821#chat',
      'http://user:pass@192.168.8.1/',
      'ftp://192.168.8.1/',
      'javascript:alert(1)',
      '192.168.8.1',
      'Harbour Fest crew',
      '',
      `http://192.168.8.1/?pin=${'1'.repeat(65)}`,
    ]) {
      expect(readJoinCode(text), text).toEqual({ kind: 'other' })
    }
  })
})

describe('a Wi-Fi QR', () => {
  it('names its network, in whatever order the fields come', () => {
    expect(readJoinCode('WIFI:T:WPA;S:Crew Net;P:secret;;')).toEqual({
      kind: 'wifi',
      ssid: 'Crew Net',
    })
    expect(readJoinCode('wifi:S:Crew;T:WPA;P:x;;')).toEqual({ kind: 'wifi', ssid: 'Crew' })
  })

  it('reads escaped characters and quotes as the cameras do', () => {
    expect(readJoinCode('WIFI:T:WPA;P:a\\;b;S:Stage\\;Left\\:\\\\2;;')).toEqual({
      kind: 'wifi',
      ssid: 'Stage;Left:\\2',
    })
    expect(readJoinCode('WIFI:S:"ABCD";T:nopass;;')).toEqual({ kind: 'wifi', ssid: 'ABCD' })
  })

  it('is still a Wi-Fi code when its name can’t be read', () => {
    expect(readJoinCode('WIFI:T:WPA;;')).toEqual({ kind: 'wifi', ssid: '' })
    expect(readJoinCode('WIFI:H;S:Crew;;')).toEqual({ kind: 'wifi', ssid: 'Crew' })
  })
})

describe('a crewbox://join link', () => {
  it('is the address as the Crew server field takes it, and the event PIN', () => {
    expect(readJoinLink('crewbox://join?server=192.168.8.1&pin=4821')).toEqual({
      kind: 'join',
      origin: 'http://192.168.8.1',
      pin: '4821',
    })
    expect(readJoinLink('crewbox://join/?server=192.168.8.1%3A3000')).toEqual({
      kind: 'join',
      origin: 'http://192.168.8.1:3000',
      pin: '',
    })
    expect(
      readJoinLink('CREWBOX://JOIN?pin=a%20b%20c&server=https%3A%2F%2FChat.Crew.Example%2F')
    ).toEqual({ kind: 'join', origin: 'https://chat.crew.example', pin: 'a b c' })
    expect(readJoinLink(' crewbox://join?server=crewbox.local \n')).toMatchObject({
      origin: 'http://crewbox.local',
    })
  })

  it('is only ever a bare address', () => {
    for (const link of [
      'crewbox://join',
      'crewbox://join?pin=4821',
      'crewbox://join?server=',
      'crewbox://join?server=192.168.8.1#chat',
      'crewbox://join?server=192.168.8.1%2Fadmin',
      'crewbox://join?server=http%3A%2F%2F192.168.8.1%2F%3Fpin%3D1',
      'crewbox://join?server=http%3A%2F%2Fuser%3Apass%40192.168.8.1',
      'crewbox://join?server=javascript%3Aalert(1)',
      'crewbox://join?server=ftp%3A%2F%2F192.168.8.1',
      'crewbox://settings?server=192.168.8.1',
      'crewbox:join?server=192.168.8.1',
      'https://192.168.8.1/?pin=4821',
      `crewbox://join?server=192.168.8.1&pin=${'1'.repeat(65)}`,
      'crewbox://join?server=192.168.8.1&pin=482',
      'crewbox://join?server=192.168.8.1&pin=48%0A21',
      '',
    ]) {
      expect(readJoinLink(link), link).toEqual({ kind: 'other' })
    }
  })
})

describe('the crewbox://join link a join page offers', () => {
  it('is the box as the field takes it, and the event PIN when there is one', () => {
    expect(joinLink('http://192.168.8.1', '4821')).toBe(
      'crewbox://join?server=192.168.8.1&pin=4821'
    )
    expect(joinLink('http://192.168.8.1:3000', '')).toBe('crewbox://join?server=192.168.8.1%3A3000')
    expect(joinLink('https://chat.crew.example', ' ab cd ')).toBe(
      'crewbox://join?server=https%3A%2F%2Fchat.crew.example&pin=ab+cd'
    )
  })

  it('leaves out a PIN the box wouldn’t take, rather than make a link the app refuses', () => {
    expect(joinLink('http://192.168.8.1', '482')).toBe('crewbox://join?server=192.168.8.1')
    expect(joinLink('http://192.168.8.1', '1'.repeat(65))).toBe('crewbox://join?server=192.168.8.1')
  })

  it('reads back as what it was made from', () => {
    for (const [origin, pin] of [
      ['http://192.168.8.1', '4821'],
      ['http://10.0.0.2:3000', ''],
      ['https://chat.crew.example', 'a b&c=d'],
      ['http://crewbox.local', '#1234'],
    ]) {
      expect(readJoinLink(joinLink(origin, pin))).toEqual({ kind: 'join', origin, pin })
    }
  })
})

describe('the same link for Chrome on Android', () => {
  const link = androidJoinLink('http://192.168.8.1', '4821', 'http://192.168.8.1/connect')

  it('names the app, and where a phone without it goes instead', () => {
    expect(link).toBe(
      'intent://join?server=192.168.8.1&pin=4821#Intent;scheme=crewbox;' +
        'package=com.colmhewson.crewbox;' +
        'S.browser_fallback_url=http%3A%2F%2F192.168.8.1%2Fconnect;end'
    )
  })

  it('is the crewbox://join link once Chrome has made it one', () => {
    // Chrome's intent: parsing: the scheme goes in place of intent:, and
    // everything from # on is the intent's, not the link's.
    const [data, extras] = link.split('#')
    const handed = data.replace(/^intent:/, 'crewbox:')
    expect(handed).toBe(joinLink('http://192.168.8.1', '4821'))
    expect(readJoinLink(handed)).toEqual({
      kind: 'join',
      origin: 'http://192.168.8.1',
      pin: '4821',
    })
    // Nothing the link carries can end the intent's part early.
    expect(extras.split(';').filter((part) => part.startsWith('S.'))).toHaveLength(1)
    expect(
      androidJoinLink('https://chat.crew.example', 'a;b#c', 'https://chat.crew.example/connect')
    ).toMatch(
      /^intent:\/\/join\?[^#;]*#Intent;scheme=crewbox;package=[^;]+;S\.browser_fallback_url=[^;#]+;end$/
    )
  })
})
