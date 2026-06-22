import type { Transaction } from '../types/api';

interface Props { transactions: Transaction[]; }

export default function RecentTransactions({ transactions }: Props) {
  if (transactions.length === 0) {
    return (
      <div className="card">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">最近交易</h3>
        <p className="text-sm text-gray-400 text-center py-8">暂无交易记录</p>
      </div>
    );
  }

  return (
    <div className="card">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">最近交易</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200">
              <th className="text-left py-2 px-3 text-gray-500 font-medium">时间</th>
              <th className="text-left py-2 px-3 text-gray-500 font-medium">类型</th>
              <th className="text-left py-2 px-3 text-gray-500 font-medium">代码</th>
              <th className="text-right py-2 px-3 text-gray-500 font-medium">股数</th>
              <th className="text-right py-2 px-3 text-gray-500 font-medium">价格</th>
              <th className="text-right py-2 px-3 text-gray-500 font-medium">金额</th>
              <th className="text-right py-2 px-3 text-gray-500 font-medium">佣金</th>
              <th className="text-left py-2 px-3 text-gray-500 font-medium">层级</th>
            </tr>
          </thead>
          <tbody>
            {transactions.map(tx => (
              <tr key={tx.id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="py-2 px-3 text-gray-600">{new Date(tx.created_at).toLocaleDateString('zh-CN')}</td>
                <td className="py-2 px-3">
                  <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${
                    tx.transaction_type === 'buy' ? 'bg-success-50 text-success-600' : 'bg-danger-50 text-danger-600'
                  }`}>{tx.transaction_type === 'buy' ? '买入' : '卖出'}</span>
                </td>
                <td className="py-2 px-3 text-gray-900 font-mono">{tx.symbol}</td>
                <td className="py-2 px-3 text-right text-gray-900">{tx.shares.toFixed(3)}</td>
                <td className="py-2 px-3 text-right text-gray-900">¥{tx.price.toFixed(2)}</td>
                <td className="py-2 px-3 text-right text-gray-900">¥{tx.amount.toFixed(2)}</td>
                <td className="py-2 px-3 text-right text-gray-500">¥{tx.commission.toFixed(2)}</td>
                <td className="py-2 px-3">
                  <span className={`text-xs ${tx.layer === 'safe' ? 'text-success-600' : 'text-primary-600'}`}>
                    {tx.layer === 'safe' ? '安全层' : '进取层'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
