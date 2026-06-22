interface Props {
  currentBalance: number;
  triggerLine: number;
  status: 'accumulating' | 'triggerable';
}

export default function TriggerProgress({ currentBalance, triggerLine, status }: Props) {
  const percentage = Math.min((currentBalance / triggerLine) * 100, 100);

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">1667 元触发线</h2>
          <p className="text-sm text-gray-500 mt-1">{status === 'triggerable' ? '已达到触发条件' : '累计中...'}</p>
        </div>
        <p className="text-2xl font-bold text-gray-900">
          ¥{currentBalance.toFixed(2)}<span className="text-sm font-normal text-gray-400"> / ¥{triggerLine}</span>
        </p>
      </div>
      <div className="relative h-4 bg-gray-200 rounded-full overflow-hidden">
        <div className={`absolute top-0 left-0 h-full rounded-full transition-all duration-500 ${
          status === 'triggerable' ? 'bg-success-500' : percentage >= 80 ? 'bg-warning-500' : 'bg-primary-500'
        }`} style={{ width: `${percentage}%` }} />
      </div>
      <div className="flex justify-between mt-2 text-xs text-gray-500">
        <span>0%</span>
        <span className={status === 'triggerable' ? 'text-success-600 font-medium' : ''}>{percentage.toFixed(1)}%</span>
        <span>100%</span>
      </div>
      {status === 'triggerable' && (
        <div className="mt-4 p-3 bg-success-50 border border-success-200 rounded-lg">
          <p className="text-sm text-success-700 font-medium">✅ 触发条件已满足！可以执行买入操作</p>
        </div>
      )}
    </div>
  );
}
