import { describe, expect, it } from 'vitest'
import { HOT_C, gradeReading, type ProcessorReading } from '@crewbox/shared'
import {
  MISSES_BEFORE_REPROBE,
  MISSES_BEFORE_UNREACHABLE,
  VideoWatcher,
  type WatcherIo,
} from '../src/video/watcher.ts'
import { VideoStore } from '../src/video/store.ts'
import * as oid from '../src/video/oids.ts'
import { respondTo } from './videoAgent.ts'

/**
 * The poller, and the verdicts it produces.
 *
 * Two things are worth defending here. First, that the box contacts only
 * what an admin armed — the resting state of this module is silence, and a
 * test that proves it is worth more than a paragraph saying so. Second, that
 * a verdict is never more confident than the reading behind it: a controller
 * that did not report a temperature must not read as "fine".
 */

/** The smallest COEX controller worth answering as: identity and one cabinet. */
const SNMP_TABLE: Record<string, string | number> = {
  [oid.CONTROLLER_MODEL]: 'MX40 Pro',
  [oid.TEMPERATURE_POINT_COUNT]: 1,
  [oid.FAN_COUNT]: 0,
  [oid.SCREEN_COUNT]: 0,
  [oid.INPUT_SLOT_COUNT]: 0,
  [oid.at(oid.TEMPERATURE_POINT_VALUE, 1)]: 42,
  [oid.at(oid.ETHERNET_PORT_COUNT, 1)]: 0,
}

/** A fake network where each host answers over one path, or neither. */
function fakeIo(hosts: Record<string, 'snmp' | 'http'>, log: string[]): WatcherIo {
  return {
    coex: {
      fetch: (url, init) => {
        const host = new URL(url).hostname
        // The runtime half of the read-only rule. videoReadOnly.test.ts reads
        // the source, which catches what somebody writes on purpose; this
        // catches what the watcher actually asks for while the poll loop is
        // running, and lands in the same log every assertion below reads.
        if (init.method !== 'GET' || init.redirect !== 'error') {
          log.push(`NOT READ-ONLY: ${init.method} ${url} redirect=${init.redirect}`)
        }
        log.push(`http ${host}`)
        if (hosts[host] !== 'http') {
          return Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({}) })
        }
        const path = new URL(url).pathname
        const body =
          path === '/api/v1/device'
            ? { model: 'MX40 Pro' }
            : path === '/api/v1/device/cabinet'
              ? [{ id: 'A1', online: true, temperature: 40 }]
              : {}
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
      },
      now: () => 1_000,
      wait: () => Promise.resolve(),
    },
    // A socket that answers with a real GetResponse when the host speaks
    // SNMP, and with the ICMP unreachable a LAN gives for an absent host
    // otherwise — so a miss costs no wall-clock in tests.
    snmp: {
      createSocket: () => {
        const listeners: Array<(buf: Buffer) => void> = []
        return {
          on: (event: string, fn: (buf: Buffer) => void) => {
            if (event === 'message') listeners.push(fn)
          },
          send: (buf: Buffer, _p: number, host: string, cb?: (e: Error | null) => void) => {
            log.push(`snmp ${host}`)
            if (hosts[host] !== 'snmp') {
              cb?.(new Error('EHOSTUNREACH'))
              return
            }
            cb?.(null)
            const reply = respondTo(buf, SNMP_TABLE)
            if (reply) for (const fn of listeners) fn(reply.packet)
          },
          close: () => {},
        } as never
      },
      now: () => 1_000,
    },
    now: () => 1_000,
  }
}

function setup(hosts: Record<string, 'snmp' | 'http'>) {
  const rows = new Map<string, string>()
  const store = new VideoStore(
    { getSetting: (k) => rows.get(k), setSetting: (k, v) => void rows.set(k, v) },
    () => 1_000
  )
  const log: string[] = []
  const watcher = new VideoWatcher({ store, io: fakeIo(hosts, log) })
  return { store, watcher, log }
}

const arm = (store: VideoStore, host: string): string => {
  const added = store.add({ host, addedBy: 'Alex' })
  if (!added.ok) throw new Error(added.reason)
  store.setMonitored(added.processor.id, true, 'Alex')
  return added.processor.id
}

describe('what the box contacts', () => {
  it('contacts nothing when nothing is armed', async () => {
    const { store, watcher, log } = setup({ '10.0.30.11': 'http' })
    store.add({ host: '10.0.30.11', addedBy: 'Alex' })
    await watcher.tick()
    // The resting state. An address in the list is not permission to talk.
    expect(log).toEqual([])
    expect(watcher.statuses()[0].state).toBe('listed')
  })

  it('contacts only the processor that was armed', async () => {
    const { store, watcher, log } = setup({ '10.0.30.11': 'http', '10.0.30.12': 'http' })
    arm(store, '10.0.30.11')
    store.add({ host: '10.0.30.12', addedBy: 'Alex' })
    await watcher.tick()
    expect(log.every((line) => line.endsWith('10.0.30.11'))).toBe(true)
  })

  it('asks for a read, every time, over the whole poll', async () => {
    // The source-level guard in videoReadOnly.test.ts catches the change
    // somebody writes on purpose. This is the same rule asked of the running
    // watcher: whatever the poll decided to do, every request it made was a
    // GET that refuses redirects.
    const { store, watcher, log } = setup({ '10.0.30.11': 'http', '10.0.30.12': 'snmp' })
    arm(store, '10.0.30.11')
    arm(store, '10.0.30.12')
    await watcher.tick()
    await watcher.tick()
    expect(log.filter((line) => line.startsWith('NOT READ-ONLY'))).toEqual([])
    // …and the loop did reach the network, so the line above means something.
    expect(log.some((line) => line.startsWith('http '))).toBe(true)
  })

  it('stops the moment monitoring goes off', async () => {
    const { store, watcher, log } = setup({ '10.0.30.11': 'http' })
    const id = arm(store, '10.0.30.11')
    await watcher.tick()
    store.setMonitored(id, false)
    log.length = 0
    await watcher.tick()
    expect(log).toEqual([])
  })
})

describe('choosing a read path', () => {
  it('prefers SNMP, which is what NovaStar publishes for monitoring', async () => {
    const { store, watcher, log } = setup({ '10.0.30.11': 'snmp' })
    arm(store, '10.0.30.11')
    await watcher.tick()
    expect(log[0]).toBe('snmp 10.0.30.11')
    expect(watcher.statuses()[0].reading?.readPath).toBe('snmp')
  })

  it('falls back to HTTP when SNMP is off at the controller', async () => {
    const { store, watcher } = setup({ '10.0.30.11': 'http' })
    arm(store, '10.0.30.11')
    await watcher.tick()
    expect(watcher.statuses()[0].reading?.readPath).toBe('http')
  })

  it('remembers the path, so an HTTP-only box is not asked over SNMP for ever', async () => {
    // Otherwise every poll pays an SNMP timeout, once per processor, all night.
    const { store, watcher, log } = setup({ '10.0.30.11': 'http' })
    arm(store, '10.0.30.11')
    await watcher.tick()
    log.length = 0
    await watcher.tick()
    expect(log.some((line) => line.startsWith('snmp'))).toBe(false)
  })

  it('works the path out again after a run of failures', async () => {
    // SNMP switched on between shows should be picked up without a restart.
    const hosts: Record<string, 'snmp' | 'http'> = { '10.0.30.11': 'http' }
    const log: string[] = []
    const rows = new Map<string, string>()
    const store = new VideoStore(
      { getSetting: (k) => rows.get(k), setSetting: (k, v) => void rows.set(k, v) },
      () => 1_000
    )
    const watcher = new VideoWatcher({ store, io: fakeIo(hosts, log) })
    arm(store, '10.0.30.11')
    await watcher.tick()

    delete hosts['10.0.30.11']
    for (let n = 0; n <= MISSES_BEFORE_REPROBE; n++) await watcher.tick()
    hosts['10.0.30.11'] = 'snmp'
    log.length = 0
    await watcher.tick()
    expect(log[0]).toBe('snmp 10.0.30.11')
    expect(watcher.statuses()[0].reading?.readPath).toBe('snmp')
  })
})

describe('when a processor goes quiet', () => {
  it('does not cry wolf over one dropped poll', async () => {
    const hosts: Record<string, 'snmp' | 'http'> = { '10.0.30.11': 'http' }
    const log: string[] = []
    const rows = new Map<string, string>()
    const store = new VideoStore(
      { getSetting: (k) => rows.get(k), setSetting: (k, v) => void rows.set(k, v) },
      () => 1_000
    )
    const watcher = new VideoWatcher({ store, io: fakeIo(hosts, log) })
    arm(store, '10.0.30.11')
    await watcher.tick()

    delete hosts['10.0.30.11']
    await watcher.tick()
    // One miss is a dropped datagram or a controller mid-reboot, not a fault
    // worth turning a pane red over.
    expect(watcher.statuses()[0].state).toBe('watching')

    for (let n = 1; n < MISSES_BEFORE_UNREACHABLE; n++) await watcher.tick()
    expect(watcher.statuses()[0].state).toBe('unreachable')
  })

  it('keeps the last good reading, and says when it was', async () => {
    const hosts: Record<string, 'snmp' | 'http'> = { '10.0.30.11': 'http' }
    const log: string[] = []
    const rows = new Map<string, string>()
    const store = new VideoStore(
      { getSetting: (k) => rows.get(k), setSetting: (k, v) => void rows.set(k, v) },
      () => 1_000
    )
    const watcher = new VideoWatcher({ store, io: fakeIo(hosts, log) })
    arm(store, '10.0.30.11')
    await watcher.tick()

    delete hosts['10.0.30.11']
    for (let n = 0; n < MISSES_BEFORE_UNREACHABLE; n++) await watcher.tick()
    const [status] = watcher.statuses()
    // "Eight cabinets, last heard 21:40" beats an empty row at 21:45.
    expect(status.reading?.model).toBe('MX40 Pro')
    expect(status.lastHeard).toBe(1_000)
  })
})

describe('grading a reading', () => {
  const base: ProcessorReading = { at: 1, readPath: 'http', cabinets: [], inputs: [], errors: [] }

  it('calls an offline cabinet a fault, and names it', () => {
    const graded = gradeReading({ ...base, cabinets: [{ id: 'A4', online: false }] })
    expect(graded).toEqual({ health: 'fault', summary: 'cabinet A4 offline' })
  })

  it('counts them once there is more than one', () => {
    const graded = gradeReading({
      ...base,
      cabinets: [
        { id: 'A4', online: false },
        { id: 'A5', online: false },
      ],
    })
    expect(graded.summary).toBe('2 cabinets offline')
  })

  it('treats a dead input as a fault', () => {
    const graded = gradeReading({
      ...base,
      inputs: [{ id: '1', name: 'SDI 1', signal: 'no-signal' }],
    })
    expect(graded).toEqual({ health: 'fault', summary: 'no signal on SDI 1' })
  })

  it('does not treat an unused input as one', () => {
    // A processor with three spare connectors is not three faults.
    const graded = gradeReading({ ...base, inputs: [{ id: '2', signal: 'not-connected' }] })
    expect(graded.health).not.toBe('fault')
  })

  it('mentions a blacked-out wall without calling it broken', () => {
    // Usually somebody's decision — but a wall that is black when nobody
    // meant it to be is exactly what you want to notice from across a site.
    expect(gradeReading({ ...base, displayMode: 'blackout' })).toEqual({
      health: 'warn',
      summary: 'blacked out',
    })
  })

  it('warns on a hot cabinet', () => {
    const graded = gradeReading({
      ...base,
      cabinets: [{ id: 'A1', online: true, temperature: HOT_C + 4 }],
    })
    expect(graded.health).toBe('warn')
    expect(graded.summary).toBe(`${HOT_C + 4}°C`)
  })

  it('says "unknown" rather than "ok" when nothing was reported', () => {
    // A screens tech reading "fine" off a box that never asked the question
    // is worse off than one reading "couldn't tell".
    expect(gradeReading(null).health).toBe('unknown')
    expect(gradeReading(base).health).toBe('unknown')
  })
})
