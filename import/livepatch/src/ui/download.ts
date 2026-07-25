import { csvFilename, sheetToCsv } from '../model/csv'
import type { SheetSnapshot } from '../model/types'

export const downloadSheetCsv = (sheet: SheetSnapshot) => {
  const blob = new Blob([sheetToCsv(sheet)], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = csvFilename(sheet)
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
