import { describe, expect, it } from 'vitest'
import { readJoinCode } from './joinCode.ts'

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
