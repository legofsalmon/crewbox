import { useState } from 'react'
import { ToastProvider } from './ui/toast'
import SheetSelector from './ui/SheetSelector'
import SheetView from './ui/SheetView'

const CURRENT_SHEET_KEY = 'livepatch-current-sheet'

export default function App() {
  const [sheetId, setSheetId] = useState<string | null>(() =>
    localStorage.getItem(CURRENT_SHEET_KEY)
  )

  const openSheet = (id: string) => {
    localStorage.setItem(CURRENT_SHEET_KEY, id)
    setSheetId(id)
  }

  const closeSheet = () => {
    localStorage.removeItem(CURRENT_SHEET_KEY)
    setSheetId(null)
  }

  return (
    <ToastProvider>
      {sheetId ? (
        <SheetView sheetId={sheetId} onClose={closeSheet} />
      ) : (
        <SheetSelector onOpen={openSheet} />
      )}
    </ToastProvider>
  )
}
