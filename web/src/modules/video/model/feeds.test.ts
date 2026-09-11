import { describe, expect, it } from 'vitest'
import type { ProcessorStatus } from '@crewbox/shared'
import { feedStatus } from './feeds.ts'

const status = (over: Partial<ProcessorStatus> = {}): ProcessorStatus => ({
  processor: {
    id: 'p1',
    name: 'Upstage MX40',
    host: '10.0.30.11',
    monitored: true,
    addedBy: 'Colm',
    addedAt: 0,
    source: 'manual',
  },
  state: 'watching',
  health: 'ok',
  summary: '',
  reading: {
    at: 0,
    readPath: 'http',
    cabinets: [],
    inputs: [
      { id: '1', name: 'HDMI 1', connector: 'HDMI 2.0', signal: 'present' },
      { id: '2', name: 'HDMI 2', signal: 'no-signal' },
      { id: '3', signal: 'not-connected' },
    ],
    errors: [],
  },
  lastHeard: 0,
  misses: 0,
  ...over,
})

describe('feedStatus', () => {
  it('says nothing for an unmapped screen', () => {
    expect(feedStatus(undefined, [status()])).toBeNull()
  })

  it('reads the signal off the mapped input', () => {
    const list = [status()]
    expect(feedStatus({ processorId: 'p1', inputId: '1' }, list)).toEqual({
      tone: 'ok',
      text: 'Upstage MX40 · HDMI 1: signal present',
    })
    expect(feedStatus({ processorId: 'p1', inputId: '2' }, list)).toEqual({
      tone: 'fault',
      text: 'Upstage MX40 · HDMI 2: NO SIGNAL',
    })
    expect(feedStatus({ processorId: 'p1', inputId: '3' }, list)).toEqual({
      tone: 'fault',
      text: 'Upstage MX40 · 3: not connected',
    })
  })

  it('never turns a processor the box is not reading into a dark wall', () => {
    expect(feedStatus({ processorId: 'p1', inputId: '1' }, [status({ state: 'listed' })])).toEqual({
      tone: 'warn',
      text: 'Upstage MX40 is not being watched',
    })
    expect(feedStatus({ processorId: 'p1', inputId: '1' }, [status({ reading: null })])).toEqual({
      tone: 'warn',
      text: 'Upstage MX40: no reading yet',
    })
    expect(feedStatus({ processorId: 'p1', inputId: '9' }, [status()])).toEqual({
      tone: 'unknown',
      text: 'Upstage MX40: input not reported',
    })
    expect(feedStatus({ processorId: 'gone', inputId: '1' }, [status()])).toEqual({
      tone: 'unknown',
      text: 'processor no longer listed',
    })
  })
})
