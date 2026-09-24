import { describe, expect, it } from 'vitest'
import {
  connectionCauses,
  connectionScreen,
  elsewhereCopy,
  elsewhereView,
  refusedCopy,
  STUCK_AFTER_MS,
} from '../src/lib/connscreen.ts'

describe('connectionScreen', () => {
  it('shows chat (ok) once connected this session, regardless of connection state', () => {
    for (const connection of ['connecting', 'online', 'offline'] as const) {
      expect(connectionScreen({ connection, hasConnected: true, hasCache: false })).toBe('ok')
    }
  })

  it('shows chat (ok) for returning users with cached content, even while offline', () => {
    expect(connectionScreen({ connection: 'offline', hasConnected: false, hasCache: true })).toBe(
      'ok'
    )
  })

  it('shows the recovery screen only when offline with nothing cached', () => {
    expect(connectionScreen({ connection: 'offline', hasConnected: false, hasCache: false })).toBe(
      'unreachable'
    )
  })

  it('does not flap back to "connecting" between retries', () => {
    // A cold start with no cache retries on a backoff, so the state cycles
    // offline → connecting → offline. Without the latch the screen swapped
    // between "Can't reach the crew server" and "Connecting…" every few
    // seconds, which reads as a device that cannot make up its mind rather
    // than a box that is not there.
    expect(
      connectionScreen({
        connection: 'connecting',
        hasConnected: false,
        hasCache: false,
        hasFailed: true,
      })
    ).toBe('unreachable')
  })

  it('shows a calm connecting state during the first connect with no cache', () => {
    expect(
      connectionScreen({ connection: 'connecting', hasConnected: false, hasCache: false })
    ).toBe('connecting')
    // 'online' but pre-welcome (no cache yet) is still "connecting", not an error.
    expect(connectionScreen({ connection: 'online', hasConnected: false, hasCache: false })).toBe(
      'connecting'
    )
  })
})

describe('what to tell someone whose box has gone quiet', () => {
  it('leads with the cause the phone hides, on the phone that hides it', () => {
    // iOS reports a healthy Wi-Fi connection while routing everything past
    // it to cellular. That is invisible from inside the app and invisible in
    // the app's own diagnostics, so it has to be the first thing said — it
    // cost a real event an hour before anyone looked at the status bar.
    const causes = connectionCauses({ ssid: 'CREW-5G', isIos: true })
    expect(causes[0]?.heading).toMatch(/status bar/)
    expect(causes[0]?.body).toMatch(/mobile data/)
  })

  it('never mentions it on a platform that does not do it', () => {
    // Android keeps using the network it is joined to. A cause that cannot
    // apply is a cause that wastes the reader's time under pressure.
    const causes = connectionCauses({ ssid: 'CREW-5G', isIos: false })
    expect(causes.some((c) => /status bar|mobile data/.test(c.heading + c.body))).toBe(false)
  })

  it('names the actual network when the box has told it one', () => {
    expect(connectionCauses({ ssid: 'CREW-5G', isIos: false })[0]?.heading).toContain('CREW-5G')
  })

  it('still reads sensibly with no SSID configured', () => {
    const causes = connectionCauses({ isIos: false })
    expect(causes[0]?.heading).toContain('the crew Wi-Fi')
    expect(causes.every((c) => !c.heading.includes('undefined'))).toBe(true)
  })

  it('always offers something to do', () => {
    for (const isIos of [true, false]) {
      const causes = connectionCauses({ isIos })
      expect(causes.length).toBeGreaterThanOrEqual(3)
      expect(causes.every((c) => c.heading && c.body)).toBe(true)
    }
  })

  it('says last, and only in the app, that the box may have moved', () => {
    // The app keeps trying the address it was given, and a box that has
    // moved never answers it: the Boxes screen is where it can be told. A
    // browser is at its box's own address, where that advice is no use.
    const app = connectionCauses({ isIos: false, canMoveBox: true })
    expect(app.at(-1)?.heading).toBe('The box may have a new address')
    expect(app.at(-1)?.body).toMatch(/tap Your boxes to look for it/)
    // While the app is looking for it, it says so, and what it does on finding it.
    const looking = connectionCauses({ isIos: false, canMoveBox: true, looksForBox: true })
    expect(looking.at(-1)?.body).toMatch(/^This phone is looking for it on this Wi-Fi/)
    expect(looking.at(-1)?.body).toMatch(/once the box shows it is the same one/)
    const browser = connectionCauses({ isIos: false })
    expect(browser.some((c) => /new address|boxes/i.test(c.heading + c.body))).toBe(false)
  })

  it('waits long enough that a roam or a restart never triggers it', () => {
    // Access-point roams and box restarts resolve in seconds. Explaining
    // those would be noise, and noise is what makes people ignore the real
    // one later.
    expect(STUCK_AFTER_MS).toBeGreaterThanOrEqual(15_000)
    expect(STUCK_AFTER_MS).toBeLessThanOrEqual(60_000)
  })
})

describe('a box at this address running another event', () => {
  // A spare box with a fresh database, or the next event's box. The phone
  // has sent it nothing, and says what is there now in the box's own words.
  const address = '10.0.0.2'

  it('names the event it is running', () => {
    expect(elsewhereCopy({ address, open: 'Harbour Fest', here: 'Harbour Tour' })).toBe(
      'The box at 10.0.0.2 is running “Harbour Tour” now.'
    )
  })

  it('says a spare under the same name is starting it afresh, not that it is the same', () => {
    // Same name, new database: its chat starts empty, and saying "is
    // running Harbour Fest" would read as "nothing has changed".
    expect(elsewhereCopy({ address, open: 'Harbour Fest', here: 'Harbour Fest ' })).toBe(
      'The box at 10.0.0.2 has changed, and is starting “Harbour Fest” afresh.'
    )
  })

  it('says a box nobody has set up yet is starting afresh', () => {
    expect(elsewhereCopy({ address, open: 'Harbour Fest', here: '' })).toBe(
      'The box at 10.0.0.2 has changed, and is starting afresh.'
    )
  })
})

describe('a box at this address saying it runs an event this phone holds elsewhere', () => {
  // Anything that took the address can say which event it runs. Until the
  // box has signed for this address with the event's key, nothing goes to
  // it and there is nothing to open (lib/identity.ts).
  const address = '10.0.0.2'
  const here = (proof?: 'checking' | 'proven' | 'refused' | 'unchecked') => ({
    id: 'saturday',
    name: 'Harbour Tour',
    ...(proof ? { held: { origin: 'http://10.0.0.3:8787', proof } } : {}),
  })
  const view = (proof?: 'checking' | 'proven' | 'refused' | 'unchecked') =>
    elsewhereView({ address, open: 'Harbour Fest', here: here(proof) })

  it('is opened from the screens only once it has shown it is that event’s box', () => {
    expect(view().opens).toBe(true)
    // The event this phone had, found here: not a new one, nor one afresh.
    expect(view('proven')).toEqual({
      copy: 'The box at 10.0.0.2 is running “Harbour Tour”, which this phone knew at 10.0.0.3:8787.',
      opens: true,
    })
    expect(
      elsewhereView({
        address,
        open: 'Harbour Fest',
        here: { ...here('proven'), name: '' },
      }).copy
    ).toBe('The box at 10.0.0.2 is running the event this phone knew at 10.0.0.3:8787.')
    for (const proof of ['checking', 'refused', 'unchecked'] as const) {
      expect(view(proof).opens, proof).toBe(false)
    }
  })

  it('says where this phone knows the event while it checks, and when it can’t', () => {
    expect(view('checking').copy).toBe(
      'The box at 10.0.0.2 says it is running “Harbour Tour”, which this phone knows at ' +
        '10.0.0.3:8787. Checking that it is…'
    )
    expect(view('unchecked').copy).toBe(
      'The box at 10.0.0.2 says it is running “Harbour Tour”, which this phone knows at ' +
        '10.0.0.3:8787. It can’t be checked, so nothing has gone to it. If that box has moved ' +
        'here, type this address in Your boxes.'
    )
  })

  it('says a box that failed the check has been sent nothing', () => {
    expect(view('refused').copy).toBe(refusedCopy({ address, name: 'Harbour Tour' }))
    expect(refusedCopy({ address, name: 'Harbour Tour' })).toBe(
      'The box at 10.0.0.2 says it is running “Harbour Tour”, but it can’t show that it is ' +
        'that event’s box, so nothing has gone to it.'
    )
    expect(refusedCopy({ address, name: ' ' })).toMatch(/is running an event, but/)
  })
})
