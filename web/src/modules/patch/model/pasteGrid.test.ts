import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  addSubBox,
  createSheetUndoManager,
  initSheet,
  pasteGrid,
  snapshotSheet,
  type PasteColumn,
} from './sheetDoc'
import { PATCH_FIELDS, patchKey } from './types'
import { addAct, snapshotTimetable } from '../../../shell/timetable/model.ts'

const newSheet = (channelCount = 4) => {
  const doc = new Y.Doc()
  const events = new Y.Doc()
  initSheet(doc, { title: 'Paste', date: '2026-07-24', channelCount })
  addAct(events, { name: 'Act 1', stage: 'Paste', date: '2026-07-24' })
  return { doc, act: snapshotTimetable(events).acts[0]!.id }
}

const columnsFor = (actId: string): PasteColumn[] => PATCH_FIELDS.map((field) => ({ actId, field }))

describe('pasteGrid', () => {
  it('fills a rectangular block right and down from the start cell', () => {
    const { doc, act } = newSheet()
    const snap = snapshotSheet(doc)

    const result = pasteGrid(doc, snap.channels[0].id, columnsFor(act).slice(1), [
      ['Kick', 'Kick in', 'Beta 91A'],
      ['Snare', 'Snare top', 'SM57'],
    ])

    expect(result).toEqual({ addedChannels: 0, writtenCells: 6 })
    const after = snapshotSheet(doc)
    expect(after.patches[patchKey(act, snap.channels[0].id)]).toMatchObject({
      input: 'Kick',
      description: 'Kick in',
      micDi: 'Beta 91A',
    })
    expect(after.patches[patchKey(act, snap.channels[1].id)]).toMatchObject({
      input: 'Snare',
      micDi: 'SM57',
    })
  })

  it('resolves sub-box references in the pasted values', () => {
    const { doc, act } = newSheet()
    const snap = snapshotSheet(doc)
    const boxId = addSubBox(doc, { name: 'Box 1', stagePosition: 'MSC' })

    pasteGrid(doc, snap.channels[0].id, columnsFor(act), [['Box 1', 'Kick', '', '', '']])
    const entry = snapshotSheet(doc).patches[patchKey(act, snap.channels[0].id)]
    expect(entry.subBoxId).toBe(boxId)
  })

  it('appends channels when the paste is taller than the sheet', () => {
    const { doc, act } = newSheet(2)
    const snap = snapshotSheet(doc)

    const rows = [['V1'], ['V2'], ['V3'], ['V4']]
    const result = pasteGrid(doc, snap.channels[1].id, columnsFor(act).slice(1, 2), rows)

    expect(result.addedChannels).toBe(3)
    const after = snapshotSheet(doc)
    expect(after.channels).toHaveLength(5)
    expect(after.patches[patchKey(act, after.channels[4].id)].input).toBe('V4')
  })

  it('drops values wider than the provided columns', () => {
    const { doc, act } = newSheet()
    const snap = snapshotSheet(doc)

    const result = pasteGrid(doc, snap.channels[0].id, columnsFor(act).slice(4), [
      ['Tall Stand', 'overflow-a', 'overflow-b'],
    ])
    expect(result.writtenCells).toBe(1)
    expect(snapshotSheet(doc).patches[patchKey(act, snap.channels[0].id)].stand).toBe('Tall Stand')
  })

  it('is a single undo step, including appended channels', () => {
    const { doc, act } = newSheet(2)
    const undoManager = createSheetUndoManager(doc)
    const snap = snapshotSheet(doc)

    pasteGrid(doc, snap.channels[0].id, columnsFor(act), [
      ['', 'Kick', '', 'Beta 91A', ''],
      ['', 'Snare', '', 'SM57', ''],
      ['', 'Hat', '', 'KSM137', ''],
    ])
    expect(snapshotSheet(doc).channels).toHaveLength(3)
    expect(undoManager.undoStack).toHaveLength(1)

    undoManager.undo()
    const after = snapshotSheet(doc)
    expect(after.channels).toHaveLength(2)
    expect(after.patches[patchKey(act, snap.channels[0].id)]).toBeUndefined()
  })
})
