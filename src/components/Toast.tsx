import type { ToastKind } from '../hooks/useToast';

import { useCallback, useMemo, useRef, useState } from 'react';

import { ToastContext } from '../hooks/useToast';

interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}

const KIND_STYLES: Record<ToastKind, string> = {
  success: 'bg-success-600 text-white',
  error: 'bg-danger-600 text-white',
  info: 'bg-gray-800 text-white',
};

export default function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextIdRef = useRef(1);

  const toast = useCallback((kind: ToastKind, text: string) => {
    const id = nextIdRef.current++;
    setToasts(prev => [...prev, { id, kind, text }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  }, []);

  const api = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext value={api}>
      {children}
      <div className="fixed top-4 right-4 z-50 space-y-2 w-80 max-w-[calc(100vw-2rem)] pointer-events-none">
        {toasts.map(t => (
          <div key={t.id}
            className={`px-4 py-3 rounded-lg shadow-lg text-sm font-medium ${KIND_STYLES[t.kind]}`}
            style={{ animation: 'toast-in 0.2s ease-out' }}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext>
  );
}
