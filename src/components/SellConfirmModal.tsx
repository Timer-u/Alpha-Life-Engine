import { useState } from 'react';

interface Props {
  confirmCode: string;
  symbol: string;
  shares: number;
  amount: number;
  submitting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 卖出摩擦弹窗：要求逐字输入随机确认串（CONFIRM_SELL-XXXX），
 * 通过增加操作成本来防止冲动卖出。
 */
export default function SellConfirmModal({ confirmCode, symbol, shares, amount, submitting, onConfirm, onCancel }: Props) {
  const [input, setInput] = useState('');
  const matched = input.trim() === confirmCode;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" role="dialog" aria-modal="true">
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-danger-50 flex items-center justify-center">
            <span className="text-danger-600 text-lg font-bold">!</span>
          </div>
          <div>
            <h3 className="text-lg font-semibold text-gray-900">确认卖出操作</h3>
            <p className="text-xs text-gray-500">卖出摩擦机制：请谨慎操作</p>
          </div>
        </div>

        <div className="mb-4 p-3 bg-gray-50 rounded-lg text-sm space-y-1">
          <div className="flex justify-between">
            <span className="text-gray-500">标的</span>
            <span className="font-mono font-medium text-gray-900">{symbol}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">卖出股数</span>
            <span className="font-mono font-medium text-gray-900">{shares.toFixed(3)} 股</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">预计金额</span>
            <span className="font-mono font-medium text-danger-600">¥{amount.toFixed(2)}</span>
          </div>
        </div>

        <p className="text-sm text-gray-600 mb-2">
          卖出会打断长期定投复利。若确定要卖出，请输入以下确认串：
        </p>
        <p className="text-center font-mono font-bold text-danger-600 text-lg mb-3 select-all tracking-wider">
          {confirmCode}
        </p>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="逐字输入上方确认串"
          className="input font-mono text-center mb-4"
          autoFocus
        />

        <div className="flex gap-3">
          <button type="button" onClick={onCancel} className="btn-secondary flex-1">
            取消（推荐）
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!matched || submitting}
            className="btn-danger flex-1 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? '提交中...' : '确认卖出'}
          </button>
        </div>
      </div>
    </div>
  );
}
