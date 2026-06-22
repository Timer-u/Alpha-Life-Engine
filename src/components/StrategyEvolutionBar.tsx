interface Props {
  lastEvolution: string | null;
  daysSince: number;
  pboScore: number | null;
  status: 'green' | 'yellow' | 'red';
}

export default function StrategyEvolutionBar({ lastEvolution, daysSince, pboScore, status }: Props) {
  const config = {
    green: { bg: 'bg-success-50', border: 'border-success-200', text: 'text-success-700', dot: 'bg-success-500', label: '正常' },
    yellow: { bg: 'bg-warning-50', border: 'border-warning-200', text: 'text-warning-700', dot: 'bg-warning-500', label: '注意' },
    red: { bg: 'bg-danger-50', border: 'border-danger-200', text: 'text-danger-700', dot: 'bg-danger-500', label: '警告' },
  }[status];

  return (
    <div className={`flex items-center gap-3 px-4 py-2 rounded-lg border ${config.bg} ${config.border}`}>
      <div className={`w-2 h-2 rounded-full ${config.dot} ${status === 'red' ? 'animate-pulse' : ''}`} />
      <div className="flex-1 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <span className={`text-sm font-medium ${config.text}`}>策略进化状态: {config.label}</span>
          <span className="text-xs text-gray-500">上次: {lastEvolution ? new Date(lastEvolution).toLocaleDateString('zh-CN') : '从未'}</span>
          <span className="text-xs text-gray-500">已过去: {daysSince === 999 ? 'N/A' : `${daysSince} 天`}</span>
        </div>
        {pboScore !== null && (
          <span className={`text-xs font-mono ${pboScore > 0.5 ? 'text-danger-600 font-bold' : 'text-gray-500'}`}>
            PBO: {(pboScore * 100).toFixed(1)}%
          </span>
        )}
      </div>
    </div>
  );
}
