import { createContext, useContext } from 'react'

export type ToastType = 'success' | 'info' | 'warning' | 'error'

export interface ToastApi {
  addToast: (title: string, message?: string, type?: ToastType) => void
}

export const ToastContext = createContext<ToastApi>({ addToast: () => {} })

export const useToasts = () => useContext(ToastContext)
