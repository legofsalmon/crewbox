import { expect, test } from '@playwright/test'
import { cell, commitCell, createSheet, newDevice, openSheetByName, uniqueName } from './helpers'

test('undo/redo: buttons, shortcuts, draft guard, and multi-user isolation', async ({
  browser,
}) => {
  const a = await newDevice(browser)
  const name = uniqueName('Undo Fest')
  await createSheet(a, name)

  // Fresh sheet: baseline structure is not undoable
  await expect(a.getByRole('button', { name: 'Undo' })).toBeDisabled()

  // Two separate commits; Ctrl+Z takes back only the last one
  await commitCell(a, 'Artist 1', '1', 'Input', 'Kick')
  await a.waitForTimeout(400) // beyond the capture window => distinct steps
  await commitCell(a, 'Artist 1', '2', 'Input', 'Snare')

  await a.keyboard.press('Control+z')
  await expect(cell(a, 'Artist 1', '1', 'Input')).toHaveValue('Kick')
  await expect(cell(a, 'Artist 1', '2', 'Input')).toHaveValue('')

  await a.keyboard.press('Control+Shift+Z')
  await expect(cell(a, 'Artist 1', '2', 'Input')).toHaveValue('Snare')

  // A dirty draft keeps native text undo — doc undo must not fire
  const draft = cell(a, 'Artist 1', '3', 'Input')
  await draft.click()
  await draft.pressSequentially('Tom')
  await a.keyboard.press('Control+z')
  await expect(cell(a, 'Artist 1', '2', 'Input')).toHaveValue('Snare')
  await draft.press('Escape')

  // Header button works
  await a.getByRole('button', { name: 'Undo' }).click()
  await expect(cell(a, 'Artist 1', '2', 'Input')).toHaveValue('')

  // Undoing on A never reverts B's concurrent edit
  const b = await newDevice(browser)
  await openSheetByName(b, name)
  await commitCell(b, 'Artist 1', '4', 'Mic/DI', 'From B')
  await expect(cell(a, 'Artist 1', '4', 'Mic/DI')).toHaveValue('From B')

  await commitCell(a, 'Artist 1', '5', 'Input', 'Local A')
  await a.keyboard.press('Control+z')
  await expect(cell(a, 'Artist 1', '5', 'Input')).toHaveValue('')
  await expect(cell(a, 'Artist 1', '4', 'Mic/DI')).toHaveValue('From B')
  await expect(cell(b, 'Artist 1', '4', 'Mic/DI')).toHaveValue('From B')
})
