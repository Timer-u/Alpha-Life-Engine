import type { Transaction } from '../types/api';

import { motion, useReducedMotion } from 'motion/react';

interface Props { transactions: Transaction[]; }

export default function RecentTransactions({ transactions }: Props) {
  const shouldReduceMotion = useReducedMotion() ?? false;

  if (transactions.length === 0) {
    return (
      <motion.div
        className="card"
        initial={{ opacity: 0, y: shouldReduceMotion ? 0 : 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: shouldReduceMotion ? 0 : 0.28 }}
      >
        <h3 className="text-lg font-semibold text-gray-900 mb-4">最近交易</h3>
        <p className="text-sm text-gray-400 text-center py-8">暂无交易记录</p>
      </motion.div>
    );
  }

  return (
    <motion.div
      className="card"
      initial={{ opacity: 0, y: shouldReduceMotion ? 0 : 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: shouldReduceMotion ? 0 : 0.28 }}
    >
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
          <motion.tbody>
            {transactions.map((tx, index) => {
              const typeClassName = tx.transaction_type === 'buy' ? 'bg-success-50 text-success-600' : 'bg-danger-50 text-danger-600';
              const layerClassName = tx.layer === 'safe' ? 'text-success-600' : 'text-primary-600';
              return (
                <motion.tr
                  key={tx.id}
                  className="border-b border-gray-100 hover:bg-gray-50 transition-colors"
                  initial={{ opacity: 0, x: shouldReduceMotion ? 0 : 8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: shouldReduceMotion ? 0 : 0.24, delay: shouldReduceMotion ? 0 : Math.min(index, 8) * 0.04 }}
                >
                  <td className="py-2 px-3 text-gray-600">{new Date(tx.created_at).toLocaleDateString('zh-CN')}</td>
                  <td className="py-2 px-3">
                    <span className={'inline-flex px-2 py-0.5 rounded text-xs font-medium ' + typeClassName}>{tx.transaction_type === 'buy' ? '买入' : '卖出'}</span>
                  </td>
                  <td className="py-2 px-3 text-gray-900 font-mono">{tx.symbol}</td>
                  <td className="py-2 px-3 text-right text-gray-900">{tx.shares.toFixed(3)}</td>
                  <td className="py-2 px-3 text-right text-gray-900">¥{tx.price.toFixed(2)}</td>
                  <td className="py-2 px-3 text-right text-gray-900">¥{tx.amount.toFixed(2)}</td>
                  <td className="py-2 px-3 text-right text-gray-500">¥{tx.commission.toFixed(2)}</td>
                  <td className="py-2 px-3">
                    <span className={'text-xs ' + layerClassName}>
                      {tx.layer === 'safe' ? '安全层' : '进取层'}
                    </span>
                  </td>
                </motion.tr>
              );
            })}
          </motion.tbody>
        </table>
      </div>
    </motion.div>
  );
}
