import { useState } from 'react';

import { useActiveAllocation } from '../hooks/useActiveAllocation';
import { isEvolvedParams } from '../types/api';

interface Props {
  lastEvolution: string | null;
  daysSince: number;
  pboScore: number | null;
  status: 'green' | 'yellow' | 'red';
}

const STATUS_CONFIG = {
  green: { bg: 'bg-success-50', border: 'border-success-200', text: 'text-success-700', dot: 'bg-success-500', label: '正常' },
  yellow: { bg: 'bg-warning-50', border: 'bg-warning-200', text: 'text-warning-700', dot: 'bg-warning-500', label: '注意' },
  red: { bg: 'bg-danger-50', border: 'border-danger-200', text: 'text-danger-700', dot: 'bg-danger-500', label: '警告' },
} as const;

function formatDate(ts: string | null): string {
  if (!ts) return '从未';
  const d = new Date(ts);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('zh-CN');
}

function formatTimestamp(ts: string | undefined | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN');
}

export default function StrategyEvolutionBar({ lastEvolution, daysSince, pboScore, status }: Props) {
  const [expanded, setExpanded] = useState(false);
  const { activeAllocation, loading, error } = useActiveAllocation(lastEvolution);

  const isEvolved = activeAllocation !== null && isEvolvedParams(activeAllocation);
  const evolvedAllocation = isEvolved ? activeAllocation : null;

  const config = STATUS_CONFIG[status];

  const sourceBadge = () => {
    if (!activeAllocation) return null;
    if (activeAllocation.source === 'evolved') {
      return (
        <span className="text-xs bg-primary-100 text-primary-700 px-2 py-0.5 rounded-full font-medium">
          策略进化
        </span>
      );
    }
    return (
      <span className="text-xs bg-warning-100 text-warning-700 px-2 py-0.5 rounded-full font-medium">
        LCH分配 (年龄 {activeAllocation.age})
      </span>
    );
  };

  const ratioBar = () => {
    if (!activeAllocation) return null;
    const safePct = ((activeAllocation.safe_ratio ?? 0.6) * 100).toFixed(0);
    const ambitionPct = ((activeAllocation.ambition_ratio ?? 0.4) * 100).toFixed(0);
    return (
      <div className="flex items-center gap-2 mt-1">
        <span className="text-xs text-gray-500">分配:</span>
        <div className="flex-1 h-2 rounded-full bg-gray-200 overflow-hidden flex">
          <div className="h-full rounded-full bg-success-500"
            style={{ width: `${safePct}%` }} title={`安全层 ${safePct}%`} />
          <div className="h-full rounded-full bg-primary-500"
            style={{ width: `${ambitionPct}%` }} title={`进取层 ${ambitionPct}%`} />
        </div>
        <span className="text-xs font-mono text-success-600">{safePct}%</span>
        <span className="text-xs font-mono text-primary-600">{ambitionPct}%</span>
      </div>
    );
  };

  const rightSlot = () => {
    if (loading) {
      return <span className="text-xs text-gray-400 animate-pulse">加载中...</span>;
    }
    if (error) {
      return (
        <>
          <span className="text-xs text-danger-600">{error}</span>
          <a href="/settings" className="text-xs text-gray-400 hover:text-gray-600">设置</a>
        </>
      );
    }
    return (
      <>
        {pboScore !== null && (
          <span className={`text-xs font-mono ${pboScore > 0.5 ? 'text-danger-600 font-bold' : 'text-gray-500'}`}>
            PBO: {(pboScore * 100).toFixed(1)}%
          </span>
        )}
        <button onClick={() => setExpanded(!expanded)}
          className="text-xs text-primary-600 hover:text-primary-700 font-medium">
          {expanded ? '收起' : '详情'}
        </button>
        <a href="/settings" className="text-xs text-gray-400 hover:text-gray-600">设置</a>
      </>
    );
  };

  return (
    <div className={`relative flex items-center gap-3 px-4 py-2 rounded-lg border ${config.bg} ${config.border}`}>
      <div className={`w-2 h-2 rounded-full ${config.dot} ${status === 'red' && !loading ? 'animate-pulse' : ''}`} />
      <div className="flex-1 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <span className={`text-sm font-medium ${config.text}`}>策略进化状态: {config.label}</span>
          <span className="text-xs text-gray-500">上次: {formatDate(lastEvolution)}</span>
          <span className="text-xs text-gray-500">已过去: {daysSince === 999 ? 'N/A' : `${daysSince} 天`}</span>
          {!loading && !error && sourceBadge()}
        </div>
        <div className="flex items-center gap-3">
          {rightSlot()}
        </div>
      </div>
      {!loading && !error && expanded && (
        <div className="absolute top-full left-0 right-0 mt-1 z-10">
          <div className="bg-white border border-gray-200 rounded-lg shadow-lg p-3 mx-4">
            {ratioBar()}
            {evolvedAllocation && (
              <>
                <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-600">
                  <span>触发线: <span className="font-mono">{evolvedAllocation.trigger_line ?? '—'}</span></span>
                  <span>BSM阈值: <span className="font-mono">{evolvedAllocation.bsm_threshold ?? '—'}</span></span>
                  <span>MA窗口: <span className="font-mono">{evolvedAllocation.ma_short_window ?? '—'}/{evolvedAllocation.ma_long_window ?? '—'}</span></span>
                  <span>进化时间: <span className="font-mono">{formatTimestamp(evolvedAllocation.evolution_timestamp)}</span></span>
                </div>
                <div className="mt-2 text-xs text-gray-500">
                  <span className="font-medium">安全层:</span>
                  {(evolvedAllocation.safe_allocation ?? []).map(a => (
                    <span key={a.symbol} className="ml-2">{a.symbol} {(a.weight * 100).toFixed(0)}%</span>
                  ))}
                </div>
                <div className="text-xs text-gray-500">
                  <span className="font-medium">进取层:</span>
                  {(evolvedAllocation.ambition_allocation ?? []).map(a => (
                    <span key={a.symbol} className="ml-2">{a.symbol} {(a.weight * 100).toFixed(0)}%</span>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}