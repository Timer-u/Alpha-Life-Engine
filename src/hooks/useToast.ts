import { createContext, use } from 'react';

export type ToastKind = 'success' | 'error' | 'info';

export interface ToastApi {
  toast: (kind: ToastKind, text: string) => void;
}

export const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = use(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
