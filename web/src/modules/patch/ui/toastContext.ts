import { useStore, type ToastKind } from '../../../store.ts'

/**
 * Shell toast service under Live Patch's hook name, so the ported components
 * stay close to upstream. Live Patch's (title, message, type) collapses into
 * the shell's single line; its 'success' kind maps to 'info'.
 */
type LiveToastKind = 'success' | 'info' | 'warning' | 'error'

const KIND_MAP: Record<LiveToastKind, ToastKind> = {
  success: 'info',
  info: 'info',
  warning: 'warning',
  error: 'error',
}

export function useToasts(): {
  addToast: (title: string, message?: string, type?: LiveToastKind) => void
} {
  const toast = useStore((s) => s.toast)
  return {
    addToast: (title, message, type = 'info') =>
      toast(message ? `${title} — ${message}` : title, KIND_MAP[type]),
  }
}
