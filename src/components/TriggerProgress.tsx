import { AnimatePresence, motion, useReducedMotion } from 'motion/react';

import { formatCents } from '../lib/money';

interface Props {
  currentBalance: number;
  triggerLine: number;
  status: 'accumulating' | 'triggerable';
}

export default function TriggerProgress({ currentBalance, triggerLine, status }: Props) {
  const shouldReduceMotion = useReducedMotion() ?? false;
  const percentage = triggerLine > 0 ? Math.min((currentBalance / triggerLine) * 100, 100) : 0;

  return (
    <motion.div
      className="card"
      initial={{ opacity: 0, y: shouldReduceMotion ? 0 : 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: shouldReduceMotion ? 0 : 0.3 }}
    >
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">{formatCents(triggerLine)} 触发线</h2>
          <p className="text-sm text-gray-500 mt-1">{status === 'triggerable' ? '已达到触发条件' : '累计中...'}</p>
        </div>
        <p className="text-2xl font-bold text-gray-900">
          {formatCents(currentBalance)}<span className="text-sm font-normal text-gray-400"> / {formatCents(triggerLine)}</span>
        </p>
      </div>
      <div className="relative h-4 bg-gray-200 rounded-full overflow-hidden">
        <motion.div
          className={
            status === 'triggerable' ? 'absolute top-0 left-0 h-full rounded-full bg-success-500' :
              percentage >= 80 ? 'absolute top-0 left-0 h-full rounded-full bg-warning-500' :
                'absolute top-0 left-0 h-full rounded-full bg-primary-500'
          }
          initial={{ width: 0 }}
          animate={{ width: percentage + '%' }}
          transition={{ duration: shouldReduceMotion ? 0 : 0.9, ease: 'easeOut' }}
        />
      </div>
      <div className="flex justify-between mt-2 text-xs text-gray-500">
        <span>0%</span>
        <motion.span
          className={status === 'triggerable' ? 'text-success-600 font-medium' : ''}
          key={percentage.toFixed(1)}
          initial={{ opacity: 0, y: shouldReduceMotion ? 0 : 4 }}
          animate={{ opacity: 1, y: 0 }}
        >
          {percentage.toFixed(1)}%
        </motion.span>
        <span>100%</span>
      </div>
      <AnimatePresence initial={false}>
        {status === 'triggerable' && (
          <motion.div
            key="triggerable"
            className="mt-4 p-3 bg-success-50 border border-success-200 rounded-lg"
            initial={{ opacity: 0, height: 0, y: shouldReduceMotion ? 0 : -4 }}
            animate={{ opacity: 1, height: 'auto', y: 0 }}
            exit={{ opacity: 0, height: 0, y: shouldReduceMotion ? 0 : -4 }}
            transition={{ duration: shouldReduceMotion ? 0 : 0.22 }}
          >
            <p className="text-sm text-success-700 font-medium">✅ 触发条件已满足！可以执行买入操作</p>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
