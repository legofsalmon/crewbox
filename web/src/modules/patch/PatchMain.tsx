import { useStore } from '../../store.ts'
import SheetSelector from './ui/SheetSelector.tsx'
import SheetView from './ui/SheetView.tsx'

/**
 * The patch module's main pane, routed by subpath: the sheet selector at
 * /m/patch, a sheet at /m/patch/sheet/<id>. Navigation goes through the
 * shell (setActiveModule), so sheets are deep-linkable and survive reloads.
 */
export default function PatchMain({ subpath }: { subpath: string }) {
  const setActiveModule = useStore((s) => s.setActiveModule)

  const sheetId = subpath.startsWith('sheet/') ? subpath.slice('sheet/'.length) : null
  if (sheetId) {
    return <SheetView sheetId={sheetId} onClose={() => setActiveModule('patch')} />
  }
  return <SheetSelector onOpen={(id) => setActiveModule('patch', `sheet/${id}`)} />
}
