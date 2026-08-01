import type { ToastKind } from '../hooks/useToast';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useCallback, useMemo, useRef, useState } from 'react';

import { ToastContext } from '../hooks/useToast';
import { toastVariants } from '../lib/motion';

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
  const shouldReduceMotion = useReducedMotion() ?? false;
  const variants = toastVariants(shouldReduceMotion);

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
        <AnimatePresence initial={false} mode="popLayout">
          {toasts.map(t => (
            <motion.div
              key={t.id}
              layout
              variants={variants}
              initial="initial"
              animate="animate"
              exit="exit"
              className={'px-4 py-3 rounded-lg shadow-lg text-sm font-medium ' + KIND_STYLES[t.kind]}
            >
              {t.text}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext>
  );
}
