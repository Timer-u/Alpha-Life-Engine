import type { CreateReconciliationResult } from '../hooks/useReconciliation';
import type { Reconciliation as ReconciliationRecord, ReconciliationStatus } from '../types/api';

import { useState } from 'react';

import { useAuth } from '../hooks/useAuth';
import { useReconciliation } from '../hooks/useReconciliation';
import { useToast } from '../hooks/useToast';

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

const STATUS_BADGES: Record<ReconciliationStatus, { className: string; label: string }> = {
  PENDING: { className: 'bg-warning-50 text-warning-700', label: '待校准' },
  CONFIRMED: { className: 'bg-success-50 text-success-600', label: '已确认' },
  ARCHIVED: { className: 'bg-gray-100 text-gray-500', label: '已归档' },
};

function variancePctLabel(rec: ReconciliationRecord): string {
  if (rec.beginning_balance <= 0) return rec.variance === 0 ? '0.00%' : '—';
  return `${((Math.abs(rec.variance) / rec.beginning_balance) * 100).toFixed(2)}%`;
}

function needsCalibration(rec: ReconciliationRecord): boolean {
  return rec.status === 'PENDING';
}

export default function Reconciliation() {
  const { logout } = useAuth();
  const { toast } = useToast();
  const { reconciliations, isLoading, isError, create, isCreating, calibrate, isCalibrating } = useReconciliation();

  const [month, setMonth] = useState(() => currentMonth());
  const [brokerBalance, setBrokerBalance] = useState('');
  const [deposits, setDeposits] = useState('');
  const [withdrawals, setWithdrawals] = useState('');
  const [fees, setFees] = useState('');
  const [notes, setNotes] = useState('');
  const [result, setResult] = useState<CreateReconciliationResult | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const broker = parseFloat(brokerBalance);
    if (isNaN(broker) || broker < 0) {
      toast('error', '请输入有效的券商总资产');
      return;
    }
    try {
      const res = await create({
        reconciliation_date: month,
        broker_balance: broker,
        deposits: deposits ? parseFloat(deposits) : undefined,
        withdrawals: withdrawals ? parseFloat(withdrawals) : undefined,
        fees: fees ? parseFloat(fees) : undefined,
        notes: notes || undefined,
      });
      setResult(res);
      toast(res.comparison.needs_calibration ? 'info' : 'success', res.message);
    } catch (err) {
      toast('error', (err as Error).message);
    }
  };

  const handleCalibrate = async (id: number) => {
    try {
      const res = await calibrate(id);
      toast('success', res.message);
      setResult(null);
    } catch (err) {
      toast('error', (err as Error).message);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-primary-600 rounded-lg flex items-center justify-center">
                <span className="text-white font-bold text-sm">α</span>
              </div>
              <h1 className="text-lg font-semibold text-gray-900">月度对账</h1>
            </div>
            <div className="flex items-center gap-4">
              <a href="/" className="text-sm text-primary-600 hover:text-primary-700">返回仪表盘</a>
              <button onClick={() => logout()} className="text-sm text-gray-500 hover:text-gray-700">退出登录</button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        <div className="card">
          <h2 className="text-lg font-semibold text-gray-900 mb-2">发起对账</h2>
          <p className="text-sm text-gray-500 mb-6">
            输入券商 App 显示的总资产，系统将与内部记录（资金池现金 + 持仓市值）比对。差异超过 1% 时可一键校准。
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="label">对账月份</label>
                <input type="month" value={month} onChange={(e) => setMonth(e.target.value)}
                  max={currentMonth()} className="input" required />
              </div>
              <div>
                <label className="label">券商总资产 (¥)</label>
                <input type="number" value={brokerBalance} onChange={(e) => setBrokerBalance(e.target.value)}
                  placeholder="0.00" step="0.01" min="0" className="input" required />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="label">本月入金 (可选)</label>
                <input type="number" value={deposits} onChange={(e) => setDeposits(e.target.value)}
                  placeholder="0.00" step="0.01" min="0" className="input" />
              </div>
              <div>
                <label className="label">本月出金 (可选)</label>
                <input type="number" value={withdrawals} onChange={(e) => setWithdrawals(e.target.value)}
                  placeholder="0.00" step="0.01" min="0" className="input" />
              </div>
              <div>
                <label className="label">费用 (可选)</label>
                <input type="number" value={fees} onChange={(e) => setFees(e.target.value)}
                  placeholder="0.00" step="0.01" min="0" className="input" />
              </div>
            </div>
            <div>
              <label className="label">备注</label>
              <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="可选" className="input" />
            </div>
            <button type="submit" disabled={isCreating} className="btn-primary disabled:opacity-50">
              {isCreating ? '对账中...' : '开始对账'}
            </button>
          </form>

          {result && (
            <div className={`mt-6 p-4 rounded-lg border ${
              result.comparison.needs_calibration ? 'bg-warning-50 border-warning-200' : 'bg-success-50 border-success-200'
            }`}>
              <h3 className="text-sm font-semibold text-gray-800 mb-3">对账结果</h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-y-2 text-sm">
                <div>
                  <p className="text-gray-500 text-xs">系统现金池</p>
                  <p className="font-mono font-medium">¥{result.comparison.system_cash.toFixed(2)}</p>
                </div>
                <div>
                  <p className="text-gray-500 text-xs">系统持仓市值</p>
                  <p className="font-mono font-medium">¥{result.comparison.system_holdings_value.toFixed(2)}</p>
                </div>
                <div>
                  <p className="text-gray-500 text-xs">系统总资产</p>
                  <p className="font-mono font-medium">¥{result.comparison.system_total.toFixed(2)}</p>
                </div>
                <div>
                  <p className="text-gray-500 text-xs">券商总资产</p>
                  <p className="font-mono font-medium">¥{result.comparison.broker_balance.toFixed(2)}</p>
                </div>
                <div>
                  <p className="text-gray-500 text-xs">差异</p>
                  <p className={`font-mono font-medium ${result.comparison.needs_calibration ? 'text-danger-600' : 'text-success-600'}`}>
                    {result.comparison.variance >= 0 ? '+' : ''}{result.comparison.variance.toFixed(2)} ({result.comparison.variance_pct.toFixed(2)}%)
                  </p>
                </div>
              </div>
              {result.comparison.needs_calibration && (
                <button onClick={() => handleCalibrate(result.reconciliation.id)} disabled={isCalibrating}
                  className="btn-primary mt-4 disabled:opacity-50">
                  {isCalibrating ? '校准中...' : '一键校准（以券商数据为准）'}
                </button>
              )}
            </div>
          )}
        </div>

        <div className="card">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">对账历史</h2>
          {isLoading ? (
            <p className="text-sm text-gray-400 animate-pulse py-8 text-center">加载中...</p>
          ) : isError ? (
            <p className="text-sm text-danger-600 text-center py-8">对账历史加载失败，请刷新页面重试</p>
          ) : reconciliations.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">暂无对账记录</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="text-left py-2 px-3 text-gray-500 font-medium">月份</th>
                    <th className="text-right py-2 px-3 text-gray-500 font-medium">系统总资产</th>
                    <th className="text-right py-2 px-3 text-gray-500 font-medium">券商总资产</th>
                    <th className="text-right py-2 px-3 text-gray-500 font-medium">差异</th>
                    <th className="text-right py-2 px-3 text-gray-500 font-medium">差异率</th>
                    <th className="text-left py-2 px-3 text-gray-500 font-medium">状态</th>
                    <th className="text-right py-2 px-3 text-gray-500 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {reconciliations.map(rec => (
                    <tr key={rec.id} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="py-2 px-3 font-mono text-gray-900">{rec.reconciliation_date}</td>
                      <td className="py-2 px-3 text-right font-mono text-gray-900">¥{rec.beginning_balance.toFixed(2)}</td>
                      <td className="py-2 px-3 text-right font-mono text-gray-900">¥{rec.ending_balance.toFixed(2)}</td>
                      <td className={`py-2 px-3 text-right font-mono ${Math.abs(rec.variance) > 0.005 ? 'text-danger-600' : 'text-gray-500'}`}>
                        {rec.variance >= 0 ? '+' : ''}{rec.variance.toFixed(2)}
                      </td>
                      <td className="py-2 px-3 text-right font-mono text-gray-500">{variancePctLabel(rec)}</td>
                      <td className="py-2 px-3">
                        <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${STATUS_BADGES[rec.status].className}`}>
                          {STATUS_BADGES[rec.status].label}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-right">
                        {needsCalibration(rec) && (
                          <button onClick={() => handleCalibrate(rec.id)} disabled={isCalibrating}
                            className="text-xs text-primary-600 hover:text-primary-700 font-medium disabled:opacity-50">
                            校准
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
