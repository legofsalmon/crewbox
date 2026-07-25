import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { ToastContext, type ToastType } from './toastContext'
import styles from './Toast.module.scss'

interface ToastItem {
  id: number
  title: string
  message?: string
  type: ToastType
}

const AUTO_DISMISS_MS = 3500
let nextId = 1

const ICONS: Record<ToastType, string> = { success: '✓', info: 'ℹ', warning: '⚠', error: '✕' }

function Toast({ toast, onRemove }: { toast: ToastItem; onRemove: (id: number) => void }) {
  // Each toast owns its dismiss timer, so new toasts never reset old ones
  // (a v1 bug: one shared effect recreated every timer on any change).
  useEffect(() => {
    const timer = setTimeout(() => onRemove(toast.id), AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [toast.id, onRemove])

  return (
    <div className={`${styles.toast} ${styles[toast.type]}`} role="status">
      <span className={styles.icon} aria-hidden="true">
        {ICONS[toast.type]}
      </span>
      <div className={styles.body}>
        <div className={styles.title}>{toast.title}</div>
        {toast.message && <div className={styles.message}>{toast.message}</div>}
      </div>
      <button
        type="button"
        className={styles.close}
        onClick={() => onRemove(toast.id)}
        aria-label="Dismiss notification"
      >
        ×
      </button>
    </div>
  )
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const addToast = useCallback((title: string, message?: string, type: ToastType = 'info') => {
    setToasts((prev) => [...prev, { id: nextId++, title, message, type }])
  }, [])

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const api = useMemo(() => ({ addToast }), [addToast])

  return (
    <ToastContext.Provider value={api}>
      {children}
      {toasts.length > 0 && (
        <div className={styles.container}>
          {toasts.map((toast) => (
            <Toast key={toast.id} toast={toast} onRemove={removeToast} />
          ))}
        </div>
      )}
    </ToastContext.Provider>
  )
}
