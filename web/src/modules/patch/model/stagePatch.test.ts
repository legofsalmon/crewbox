import { describe, expect, it } from 'vitest'
import { effectiveInput, stagePatchClashes, stagePatchFor } from './stagePatch'
import { emptyPatchEntry, patchKey, type PatchEntry, type SheetSnapshot } from './types'

const sheet = (over: Partial<SheetSnapshot> = {}): SheetSnapshot => ({
  meta: { title: 'Main Stage', stage: '', date: '', created: '' },
  channels: [
    { id: 'c1', label: '1', input: 'KICK IN' },
    { id: 'c2', label: '2', input: 'SNARE TOP' },
    { id: 'c3', label: '3', input: 'BASS' },
  ],
  extras: {},
  subBoxes: [{ id: 'b1', name: 'PINK', inputs: 4, color: '#ff00ff', stagePosition: 'USC' }],
  patches: {},
  ...over,
})

const patch = (over: Partial<PatchEntry>): PatchEntry => ({ ...emptyPatchEntry(), ...over })

describe('reading the sheet from the stage end', () => {
  it('turns cells into a tail-by-tail table', () => {
    const snapshot = sheet({
      patches: {
        [patchKey('a1', 'c1')]: patch({ subBoxId: 'b1', subBoxTail: 1, micDi: 'sE KICK' }),
        [patchKey('a1', 'c2')]: patch({ subBoxId: 'b1', subBoxTail: 3, micDi: 'SM 57' }),
      },
    })
    const [run] = stagePatchFor(snapshot, 'a1')

    expect(run.name).toBe('PINK')
    expect(run.stagePosition).toBe('USC')
    expect(run.rows.map((r) => r.channel?.label ?? null)).toEqual(['1', null, '2', null])
    expect(run.rows[0].input).toBe('KICK IN')
    expect(run.rows[0].micDi).toBe('sE KICK')
    expect(run.used).toBe(2)
  })

  it('shows a half-used box at its full width', () => {
    // The empty tails are the point: they are where the next thing goes.
    const snapshot = sheet({
      patches: { [patchKey('a1', 'c1')]: patch({ subBoxId: 'b1', subBoxTail: 1 }) },
    })
    expect(stagePatchFor(snapshot, 'a1')[0].rows).toHaveLength(4)
  })

  it('lists a box that only exists as text, at the width it is used', () => {
    // Nothing says how big an undefined box is, so inventing empty tails for
    // it would be inventing capacity nobody has.
    const snapshot = sheet({
      patches: {
        [patchKey('a1', 'c1')]: patch({ subBoxText: 'BSNAKE', subBoxTail: 2 }),
        [patchKey('a1', 'c2')]: patch({ subBoxText: 'BSNAKE', subBoxTail: 7 }),
      },
    })
    const runs = stagePatchFor(snapshot, 'a1')
    const bsnake = runs.find((r) => r.name === 'BSNAKE')!
    expect(bsnake.subBox).toBeNull()
    expect(bsnake.rows.map((r) => r.tail)).toEqual([2, 7])
  })

  it('flags two channels down one tail', () => {
    // The paper version can't show this at all — there is one box to write a
    // channel number in, so the second one just never gets written down.
    const snapshot = sheet({
      patches: {
        [patchKey('a1', 'c1')]: patch({ subBoxId: 'b1', subBoxTail: 2 }),
        [patchKey('a1', 'c2')]: patch({ subBoxId: 'b1', subBoxTail: 2 }),
      },
    })
    const runs = stagePatchFor(snapshot, 'a1')
    expect(runs[0].rows[1].clashes.map((c) => c.label)).toEqual(['2'])
    expect(stagePatchClashes(runs)).toEqual([{ box: 'PINK', tail: 2 }])
  })

  it('ignores cells with no tail', () => {
    const snapshot = sheet({
      patches: { [patchKey('a1', 'c1')]: patch({ subBoxId: 'b1', subBoxTail: null }) },
    })
    expect(stagePatchFor(snapshot, 'a1')[0].used).toBe(0)
  })

  it('keeps one act out of another’s table', () => {
    const snapshot = sheet({
      patches: { [patchKey('a2', 'c1')]: patch({ subBoxId: 'b1', subBoxTail: 1 }) },
    })
    expect(stagePatchFor(snapshot, 'a1')[0].used).toBe(0)
    expect(stagePatchFor(snapshot, 'a2')[0].used).toBe(1)
  })
})

describe('the house input', () => {
  it('is what a tail carries unless the act overrode it', () => {
    const channel = { id: 'c1', label: '1', input: 'KICK IN' }
    expect(effectiveInput(undefined, channel)).toBe('KICK IN')
    expect(effectiveInput(patch({ input: '' }), channel)).toBe('KICK IN')
    expect(effectiveInput(patch({ input: 'KICK OUT' }), channel)).toBe('KICK OUT')
    // Whitespace isn't an override — it's a cell someone tabbed through.
    expect(effectiveInput(patch({ input: '  ' }), channel)).toBe('KICK IN')
  })
})
