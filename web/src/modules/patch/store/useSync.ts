import { sheetRoom } from './docManager.ts'
import { useRemotePeers, useSyncPeers } from '../../_shared/docs/hooks.ts'
import type { RemotePeer } from '../../_shared/docs/sync.ts'

export { useSyncStatus } from '../../_shared/docs/hooks.ts'
export type { RemotePeer, SyncStatus } from '../../_shared/docs/sync.ts'

/** Devices (including this one) currently in the given sheet's sync room. */
export const useSheetPeers = (sheetId: string): number => useSyncPeers(sheetRoom(sheetId))

/** Remote peers (name, color, editing cell) in the given sheet's sync room. */
export const useSheetRemotePeers = (sheetId: string): RemotePeer[] =>
  useRemotePeers(sheetRoom(sheetId))
