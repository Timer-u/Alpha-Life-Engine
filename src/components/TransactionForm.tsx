import type { TransactionType, LayerType } from '../types/api';

import { useState, useCallback } from 'react';

import { usePortfolio } from '../hooks/usePortfolio';

interface Props { onSuccess: () => void; }

export default function TransactionForm({ onSuccess }: Props) {
  const { createTransaction, isCreating, calculateCommission } = usePortfolio();
  const [symbol, setSymbol] = useState('511360');
  const [shares, setShares] = useState('');
  const [price, setPrice] = useState('');
  const [commission, setCommission] = useState('');
  const [transactionType, setTransactionType] = useState<TransactionType>('buy');
  const [layer, setLayer] = useState<LayerType>('safe');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');

  const amount = parseFloat(shares) * parseFloat(price) || 0;

  const handleCalculateCommission = useCallback(async () => {
    if (amount > 0) {
      try {
        const result = await calculateCommission(amount);
        setCommission(result.commission.toFixed(2));
      } catch {
        setCommission(Math.max(amount * 0.0003, 5).toFixed(2));
      }
    }
  }, [amount, calculateCommission]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const formCommission = commission ? parseFloat(commission) : Math.max(amount * 0.0003, 5);

    try {
      await createTransaction({
        symbol, shares: parseFloat(shares), price: parseFloat(price),
        commission: formCommission, transaction_type: transactionType, layer,
        notes: notes || undefined,
      });
      setShares(''); setPrice(''); setCommission(''); setNotes(''); setError('');
      onSuccess();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="card">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">记录交易</h3>
      {error && <div className="mb-4 p-3 bg-danger-50 text-danger-600 text-sm rounded-lg">{error}</div>}
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">交易类型</label>
            <select value={transactionType} onChange={(e) => setTransactionType(e.target.value as TransactionType)} className="input">
              <option value="buy">买入</option>
              <option value="sell">卖出</option>
            </select>
          </div>
          <div>
            <label className="label">层级</label>
            <select value={layer} onChange={(e) => setLayer(e.target.value as LayerType)} className="input">
              <option value="safe">安全层</option>
              <option value="ambition">进取层</option>
            </select>
          </div>
        </div>
        <div>
          <label className="label">股票代码</label>
          <select value={symbol} onChange={(e) => setSymbol(e.target.value)} className="input">
            <option value="511360">511360 海富通短融ETF</option>
            <option value="511880">511880 银华日利</option>
          </select>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">股数</label>
            <input type="number" value={shares} onChange={(e) => setShares(e.target.value)}
              placeholder="0.00" step="0.001" min="0" className="input" required />
          </div>
          <div>
            <label className="label">价格</label>
            <input type="number" value={price} onChange={(e) => setPrice(e.target.value)}
              placeholder="0.00" step="0.001" min="0" className="input" required />
          </div>
        </div>
        <div>
          <label className="label">佣金 (必填)</label>
          <div className="flex gap-2">
            <input type="number" value={commission} onChange={(e) => setCommission(e.target.value)}
              placeholder={`max(${amount.toFixed(2)} × 0.03%, 5)`} step="0.01" min="0"
              className="input flex-1" required />
            <button type="button" onClick={handleCalculateCommission} className="btn-secondary whitespace-nowrap">自动计算</button>
          </div>
          <p className="mt-1 text-xs text-gray-500">公式: max(金额 × 0.03%, 5元)</p>
        </div>
        <div>
          <label className="label">备注</label>
          <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="可选" className="input" />
        </div>
        <div className="pt-2">
          <p className="text-sm text-gray-600 mb-3">金额: ¥{amount.toFixed(2)} · 佣金: ¥{commission ? parseFloat(commission).toFixed(2) : '0.00'}</p>
          <button type="submit" disabled={isCreating} className="btn-primary w-full disabled:opacity-50">
            {isCreating ? '提交中...' : '提交交易'}
          </button>
        </div>
      </form>
    </div>
  );
}
