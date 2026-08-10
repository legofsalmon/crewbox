import { useEffect, useMemo, useState } from 'react'
import { sheetStore } from '../../patch/store/docManager.ts'
import { snapshotSheet } from '../../patch/model/sheetDoc.ts'
import { useDocIndex } from '../../_shared/docs/hooks.ts'
import { toAgendaAct, type AgendaAct } from '../model/agenda.ts'

/**
 * How long edits are gathered before the running order is recomputed. A Yjs
 * edit fires one update per keystroke and an import fires thousands in a
 * burst; the running order is read at a glance, so a beat of latency costs
 * nothing and the storm collapses into one pass.
 */
const COALESCE_MS = 250

/**
 * Every act on every patch sheet this device knows about.
 *
 * Schedule owns no documents of its own, on purpose. A festival patch sheet
 * is already one stage's day, complete with set times imported from the
 * production company's spreadsheet, and asking anyone to type the running
 * order a second time is how you get a running order nobody maintains. So
 * this reads what audio already keeps, and every correction they make to a
 * set time shows up here without anyone doing anything.
 *
 * It opens each sheet rather than reading the index, because the index
 * carries only a sheet's title, stage and date — the acts live in the
 * documents. Sheets are small and already cached locally, and a festival has
 * a handful of stages rather than hundreds.
 */
export function useAgendaActs(): { acts: AgendaAct[]; sheets: number; loaded: boolean } {
  const { entries, loaded } = useDocIndex(sheetStore)
  const [acts, setActs] = useState<AgendaAct[]>([])

  // Keyed on the identity of the set of sheets, not the array, which
  // useDocIndex rebuilds on every index change — including the ones this
  // effect is here to observe.
  const ids = useMemo(() => entries.map((entry) => entry.id).join(' '), [entries])

  useEffect(() => {
    if (!ids) {
      setActs([])
      return
    }
    let live = true
    // present: false — this reads every sheet on the box, and a reader is
    // not a person. Without it, every device running the running order shows
    // up in every sheet's presence, so a patch operator sees company in a
    // sheet nobody else has open.
    const handles = ids.split(' ').map((id) => sheetStore.open(id, { present: false }))

    const recompute = () => {
      if (!live) return
      const next: AgendaAct[] = []
      for (const handle of handles) {
        const sheet = snapshotSheet(handle.doc)
        // The sheet's stage, not the act's: a patch sheet *is* a stage's
        // day, and its title is usually the event rather than the stage.
        const stage = sheet.meta.stage || sheet.meta.title
        for (const artist of sheet.artists) {
          if (!artist.name.trim()) continue
          next.push(
            toAgendaAct({
              id: artist.id,
              name: artist.name,
              stage,
              startTime: artist.startTime,
              endTime: artist.endTime,
              changeover: artist.changeover,
            })
          )
        }
      }
      setActs(next)
    }

    let pending: ReturnType<typeof setTimeout> | undefined
    const scheduleRecompute = () => {
      if (pending) return
      pending = setTimeout(() => {
        pending = undefined
        recompute()
      }, COALESCE_MS)
    }

    for (const handle of handles) {
      handle.whenLoaded.then(scheduleRecompute).catch(() => {})
      handle.doc.on('update', scheduleRecompute)
    }
    recompute()

    return () => {
      live = false
      if (pending) clearTimeout(pending)
      for (const handle of handles) handle.doc.off('update', scheduleRecompute)
    }
  }, [ids])

  return { acts, sheets: entries.length, loaded }
}
