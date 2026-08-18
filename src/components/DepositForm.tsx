import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useState } from 'react';

import { useActiveAllocation } from '../hooks/useActiveAllocation';
import { usePortfolio } from '../hooks/usePortfolio';
import { useToast } from '../hooks/useToast';
import { yuanToCents } from '../lib/money';

interface Props {
  lastEvolution: string | null;
  onSuccess: () => void;
}

/**
 * 资金池充值：按当前生效分配比例（策略演化参数或 LCH 兜底）
 * 自动切分到安全层 / 进取层。
 */
export default function DepositForm({ lastEvolution, onSuccess }: Props) {
  const { deposit, isDepositing } = usePortfolio();
  const { activeAllocation } = useActiveAllocation(lastEvolution);
  const { toast } = useToast();
  const shouldReduceMotion = useReducedMotion() ?? false;
  const [amount, setAmount] = useState('');

  const parsedAmount = parseFloat(amount) || 0;
  const safeRatio = activeAllocation?.safe_ratio ?? 0.6;
  const safePreview = parsedAmount * safeRatio;
  const ambitionPreview = parsedAmount - safePreview;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (parsedAmount <= 0) return;
    try {
      const amountCents = yuanToCents(parsedAmount);
      const result = await deposit({ amountCents, idempotencyKey: crypto.randomUUID() });
      setAmount('');
      if (result.duplicate) {
        toast('info', result.message);
      } else {
        toast('success', result.message);
      }
      onSuccess();
    } catch (err) {
      toast('error', (err as Error).message);
    }
  };

  return (
    <motion.div
      className="card"
      initial={{ opacity: 0, y: shouldReduceMotion ? 0 : 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: shouldReduceMotion ? 0 : 0.3 }}
      whileHover={shouldReduceMotion ? undefined : { y: -2 }}
    >
      <h3 className="text-lg font-semibold text-gray-900 mb-1">充值资金池</h3>
      <p className="text-sm text-gray-500 mb-4">
        每月充值后按
        {activeAllocation?.source === 'evolved' ? '演化策略' : ' LCH '}
        比例自动切分双层
      </p>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="label">充值金额 (¥)</label>
          <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00" step="0.01" min="0" className="input" required />
        </div>

        <AnimatePresence initial={false}>
          {parsedAmount > 0 && (
            <motion.div
              key="preview"
              className="p-3 bg-gray-50 rounded-lg space-y-2 overflow-hidden"
              initial={{ opacity: 0, height: 0, y: shouldReduceMotion ? 0 : -4 }}
              animate={{ opacity: 1, height: 'auto', y: 0 }}
              exit={{ opacity: 0, height: 0, y: shouldReduceMotion ? 0 : -4 }}
              transition={{ duration: shouldReduceMotion ? 0 : 0.22 }}
            >
              <p className="text-xs text-gray-500">切分预览</p>
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-success-500" />
                  安全层 ({(safeRatio * 100).toFixed(0)}%)
                </span>
                <motion.span key={safePreview.toFixed(2)} className="font-mono font-medium text-success-600" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>+¥{safePreview.toFixed(2)}</motion.span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-primary-500" />
                  进取层 ({((1 - safeRatio) * 100).toFixed(0)}%)
                </span>
                <motion.span key={ambitionPreview.toFixed(2)} className="font-mono font-medium text-primary-600" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>+¥{ambitionPreview.toFixed(2)}</motion.span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <motion.button
          type="submit"
          disabled={isDepositing || parsedAmount <= 0}
          className="btn-primary w-full disabled:opacity-50"
          whileHover={shouldReduceMotion ? undefined : { y: -1 }}
          whileTap={shouldReduceMotion ? undefined : { scale: 0.98 }}
        >
          {isDepositing ? '充值中...' : '充值并切分'}
        </motion.button>
      </form>
    </motion.div>
  );
}
