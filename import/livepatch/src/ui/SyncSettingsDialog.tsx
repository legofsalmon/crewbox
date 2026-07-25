import { useEffect, useState } from 'react'
import { syncManager } from '../store/sync'
import { normalizeSyncUrl } from '../store/syncSettings'
import { useToasts } from './toastContext'
import styles from './Manager.module.scss'

export default function SyncSettingsDialog({ onClose }: { onClose: () => void }) {
  const { addToast } = useToasts()
  const current = syncManager.getSettings()
  const [url, setUrl] = useState(current.url)
  const [token, setToken] = useState(current.token)
  const [userName, setUserName] = useState(syncManager.getUserName())

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleSave = () => {
    const normalized = normalizeSyncUrl(url)
    syncManager.setUserName(userName)
    syncManager.updateSettings({ url: normalized, token: token.trim() })
    addToast(
      normalized ? 'Sync configured' : 'Sync disabled',
      normalized ? `Connecting to ${normalized}` : 'Working local-only on this device',
      'info'
    )
    onClose()
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={styles.popover}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sync-settings-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <h2 id="sync-settings-title">Sync Settings</h2>
          <button type="button" className={styles.closeButton} onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className={styles.content}>
          <p className={styles.hint}>
            The app always works offline on this device. Add a relay server to sync with other
            devices — a cloud URL when you have internet, or the address of a laptop running the
            relay on the venue network (e.g. <code>ws://192.168.1.20:1234</code>). Leave the URL
            empty to stay local-only.
          </p>
          <div className={styles.notes}>
            <label htmlFor="sync-name">Your name (shown to other devices):</label>
            <input
              id="sync-name"
              className={styles.wideInput}
              type="text"
              placeholder="e.g. Monitors — Sam"
              maxLength={40}
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
            />
          </div>
          <div className={styles.notes}>
            <label htmlFor="sync-url">Relay server URL:</label>
            <input
              id="sync-url"
              className={styles.wideInput}
              type="text"
              placeholder="wss://sync.example.com or ws://192.168.1.20:1234"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              autoFocus
            />
          </div>
          <div className={styles.notes}>
            <label htmlFor="sync-token">Access token:</label>
            <input
              id="sync-token"
              className={styles.wideInput}
              type="password"
              placeholder="Shared token configured on the relay"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </div>
          <div className={styles.dialogActions}>
            <button type="button" className={styles.addButton} onClick={handleSave}>
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
