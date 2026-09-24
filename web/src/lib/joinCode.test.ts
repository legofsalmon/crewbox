import { describe, expect, it } from 'vitest'
import {
  androidJoinLink,
  joinLink,
  readJoinCode,
  readJoinLink,
  wifiToJoin,
  type WifiCode,
} from './joinCode.ts'

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

/** A Wi-Fi code's reading, with what a test doesn't say left as a WPA network's. */
const wifi = (fields: Partial<WifiCode>): WifiCode => ({
  kind: 'wifi',
  ssid: 'Crew Net',
  password: '',
  security: 'wpa',
  hidden: false,
  ...fields,
})

describe('a Wi-Fi QR', () => {
  it('names its network and password, in whatever order the fields come', () => {
    expect(readJoinCode('WIFI:T:WPA;S:Crew Net;P:secret;;')).toEqual(
      wifi({ ssid: 'Crew Net', password: 'secret' })
    )
    expect(readJoinCode('wifi:S:Crew;T:WPA;P:x;;')).toEqual(wifi({ ssid: 'Crew', password: 'x' }))
  })

  it('reads escaped characters and quotes as the cameras do', () => {
    expect(readJoinCode('WIFI:T:WPA;P:a\\;b;S:Stage\\;Left\\:\\\\2;;')).toEqual(
      wifi({ ssid: 'Stage;Left:\\2', password: 'a;b' })
    )
    expect(readJoinCode('WIFI:S:"ABCD";T:nopass;;')).toEqual(
      wifi({ ssid: 'ABCD', security: 'open' })
    )
    // Quoted so that a reader doesn't take it for the key in hex.
    expect(readJoinCode('WIFI:S:Crew;T:WPA;P:"12345678";;')).toEqual(
      wifi({ ssid: 'Crew', password: '12345678' })
    )
    // Escaped quotes are part of the name.
    expect(readJoinCode('WIFI:S:\\"Crew\\";T:nopass;;')).toEqual(
      wifi({ ssid: '"Crew"', security: 'open' })
    )
    expect(readJoinCode('WIFI:S:"Crew\\";T:nopass;;')).toEqual(
      wifi({ ssid: '"Crew"', security: 'open' })
    )
  })

  it('says how the network is secured, however the code spells it', () => {
    const security = (text: string) => (readJoinCode(text) as WifiCode).security
    // As Android's own scanner reads them: any WPA takes a WPA2 password,
    // which is how WPA2/WPA3 networks take one too.
    for (const type of ['WPA', 'wpa', 'WPA2', 'WPA3', 'WPA/WPA2', 'WPA2/WPA3', 'WPA2-PSK']) {
      expect(security(`WIFI:T:${type};S:Crew;P:backstage;;`), type).toBe('wpa')
    }
    // SAE, as Android writes a WPA3-only network's code, is WPA3 alone.
    for (const type of ['SAE', 'sae']) {
      expect(security(`WIFI:T:${type};S:Crew;P:backstage;;`), type).toBe('wpa3')
    }
    // WEP, an enterprise network, whatever its T says when it names an EAP
    // method, and anything else: the phone's own settings, not the app.
    for (const text of [
      'WIFI:T:WEP;S:Crew;P:0123456789;;',
      'WIFI:T:WPA2-EAP;S:Crew;E:PEAP;I:tech;P:backstage;;',
      'WIFI:T:WPA;S:Crew;E:TTLS;I:tech;P:backstage;;',
      'WIFI:T:OWE;S:Crew;;',
    ]) {
      expect(security(text), text).toBe('other')
    }
  })

  it('is an open network with no password when it says so, or says nothing', () => {
    // The format's own rule: nopass, or no T at all, and any P is ignored.
    expect(readJoinCode('WIFI:T:nopass;S:Foyer;P:ignored;;')).toEqual(
      wifi({ ssid: 'Foyer', security: 'open' })
    )
    expect(readJoinCode('WIFI:S:Foyer;;')).toEqual(wifi({ ssid: 'Foyer', security: 'open' }))
    // But a password with no T is taken to be wanted.
    expect(readJoinCode('WIFI:S:Crew;P:backstage;;')).toEqual(
      wifi({ ssid: 'Crew', password: 'backstage' })
    )
  })

  it('is WPA3 alone when its R, the transition disable bits, has bit 0 set', () => {
    const security = (text: string) => (readJoinCode(text) as WifiCode).security
    for (const r of ['1', '3', 'F', '01']) {
      expect(security(`WIFI:T:WPA;R:${r};S:Crew;P:backstage;;`), r).toBe('wpa3')
    }
    // Hex digits only, as the WPA3 specification writes it.
    for (const r of ['0', '2', '10', 'x', '0x1', '']) {
      expect(security(`WIFI:T:WPA;R:${r};S:Crew;P:backstage;;`), r).toBe('wpa')
    }
    // Only WPA: R has nothing to say about an open network or WEP.
    expect(security('WIFI:T:nopass;R:1;S:Crew;;')).toBe('open')
    expect(security('WIFI:T:WEP;R:1;S:Crew;P:0123456789;;')).toBe('other')
  })

  it('is hidden only when it says H:true', () => {
    const hidden = (text: string) => (readJoinCode(text) as WifiCode).hidden
    expect(hidden('WIFI:T:WPA;S:Crew;P:backstage;H:true;;')).toBe(true)
    expect(hidden('WIFI:T:WPA;S:Crew;P:backstage;H:TRUE;;')).toBe(true)
    expect(hidden('WIFI:T:WPA;S:Crew;P:backstage;H:false;;')).toBe(false)
    // H once named an enterprise network's second phase, and still can.
    expect(hidden('WIFI:T:WPA2-EAP;S:Crew;E:PEAP;H:MSCHAPV2;;')).toBe(false)
  })

  it('is still a Wi-Fi code when its name can’t be read', () => {
    expect(readJoinCode('WIFI:T:WPA;;')).toEqual(wifi({ ssid: '' }))
    expect(readJoinCode('WIFI:H;S:Crew;;')).toEqual(wifi({ ssid: 'Crew', security: 'open' }))
  })
})

describe('joining a Wi-Fi code’s network', () => {
  it('is its name, password, and whether it is WPA3 alone or hidden', () => {
    expect(wifiToJoin(wifi({ password: 'backstage' }))).toEqual({
      ssid: 'Crew Net',
      password: 'backstage',
      wpa3: false,
      hidden: false,
    })
    expect(wifiToJoin(wifi({ password: 'backstage', security: 'wpa3', hidden: true }))).toEqual({
      ssid: 'Crew Net',
      password: 'backstage',
      wpa3: true,
      hidden: true,
    })
    expect(wifiToJoin(wifi({ security: 'open' }))).toEqual({
      ssid: 'Crew Net',
      password: '',
      wpa3: false,
      hidden: false,
    })
  })

  it('leaves WEP and enterprise networks to the phone’s settings', () => {
    expect(wifiToJoin(wifi({ security: 'other', password: 'backstage' }))).toBe('settings')
  })

  it('takes a name of 1 to 32 bytes', () => {
    const named = (ssid: string) => wifiToJoin(wifi({ ssid, password: 'backstage' }))
    expect(named('')).toBe('invalid')
    expect(named('a'.repeat(33))).toBe('invalid')
    expect(named('a'.repeat(32))).not.toBe('invalid')
    // Bytes, not characters: a euro sign is three.
    expect(named('€'.repeat(11))).toBe('invalid')
    expect(named('€'.repeat(10))).not.toBe('invalid')
    expect(wifiToJoin(wifi({ ssid: '', security: 'other' }))).toBe('invalid')
  })

  it('takes a WPA password of 8 to 63 characters, and leaves a key in hex to the settings', () => {
    const password = (password: string) => wifiToJoin(wifi({ password }))
    expect(password('back123')).toBe('invalid')
    expect(password('backstage')).not.toBe('invalid')
    expect(password('x'.repeat(63))).not.toBe('invalid')
    expect(password('x'.repeat(64))).toBe('invalid')
    // Neither phone takes the key itself from an app, and their settings do.
    expect(password('0123456789abcdef'.repeat(4))).toBe('settings')
    expect(password('0123456789ABCDEF'.repeat(4))).toBe('settings')
    expect(password('0123456789abcdef'.repeat(4).slice(1))).not.toBe('invalid')
    expect(password('bäckstage')).toBe('invalid')
    expect(password('back\nstage')).toBe('invalid')
  })

  it('takes a shorter password for WPA3 alone, and no key', () => {
    const password = (password: string) => wifiToJoin(wifi({ password, security: 'wpa3' }))
    expect(password('crew')).not.toBe('invalid')
    expect(password('')).toBe('invalid')
    expect(password('0123456789abcdef'.repeat(4))).toBe('invalid')
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
