import type { EChartsOption } from '../lib/echarts';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';

import { useLayerPerformance } from '../hooks/usePortfolio';
import { echarts, ReactEChartsCore as EChart } from '../lib/echarts';
import { formatCents } from '../lib/money';

interface PortfolioPoint {
  market: number;
  invested: number;
  gain: number;
}

/**
 * 组合净值曲线：总资产 / 累计投入 / 累计盈亏的历史趋势（双层合并，
 * 定投复利的核心可视化）。
 */
export default function PortfolioNavChart() {
  const { performance, isLoading, isError } = useLayerPerformance();
  const shouldReduceMotion = useReducedMotion() ?? false;

  // 双层按日期对齐合并（安全层 + 进取层同日相加）
  const byDate = new Map<string, PortfolioPoint>();
  const accumulate = (points: { date: string; market_value: number; invested: number; cumulative_gain: number }[]) => {
    for (const p of points) {
      const cur = byDate.get(p.date) ?? { market: 0, invested: 0, gain: 0 };
      cur.market += p.market_value;
      cur.invested += p.invested;
      cur.gain += p.cumulative_gain;
      byDate.set(p.date, cur);
    }
  };
  if (performance) {
    accumulate(performance.safe);
    accumulate(performance.ambition);
  }
  const dates = [...byDate.keys()].sort();
  const latest = dates.length > 0 ? byDate.get(dates[dates.length - 1]) : undefined;

  const option: EChartsOption = {
    animation: !shouldReduceMotion,
    tooltip: {
      trigger: 'axis',
      valueFormatter: v => formatCents(Math.round(Number(v) * 100)),
    },
    legend: { data: ['总资产', '累计投入', '累计盈亏'], bottom: 0, icon: 'circle' },
    grid: { left: 8, right: 16, top: 16, bottom: 32, containLabel: true },
    xAxis: { type: 'time' },
    yAxis: { type: 'value', axisLabel: { formatter: '¥{value}' }, splitLine: { lineStyle: { type: 'dashed' } } },
    series: [
      {
        name: '总资产',
        type: 'line',
        showSymbol: false,
        smooth: true,
        itemStyle: { color: '#0f172a' },
        lineStyle: { color: '#0f172a', width: 2 },
        data: dates.map(d => [d, (byDate.get(d)?.market ?? 0) / 100]),
      },
      {
        name: '累计投入',
        type: 'line',
        showSymbol: false,
        smooth: true,
        itemStyle: { color: '#9ca3af' },
        lineStyle: { color: '#9ca3af', width: 2, type: 'dashed' },
        data: dates.map(d => [d, (byDate.get(d)?.invested ?? 0) / 100]),
      },
      {
        name: '累计盈亏',
        type: 'line',
        showSymbol: false,
        smooth: true,
        itemStyle: { color: '#16a34a' },
        lineStyle: { color: '#16a34a', width: 2 },
        areaStyle: { color: '#16a34a', opacity: 0.06 },
        data: dates.map(d => [d, (byDate.get(d)?.gain ?? 0) / 100]),
      },
    ],
  };

  const cardVariants = {
    initial: { opacity: 0, y: shouldReduceMotion ? 0 : 10 },
    animate: { opacity: 1, y: 0, transition: { duration: shouldReduceMotion ? 0 : 0.32 } },
  };

  return (
    <motion.div className="card" variants={cardVariants} initial="initial" animate="animate" whileHover={shouldReduceMotion ? undefined : { y: -2 }}>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900">组合净值</h3>
        {latest && (
          <div className="flex items-center gap-4 text-xs font-mono">
            <span className="text-gray-700">总资产 {formatCents(latest.market)}</span>
            <span className={latest.gain >= 0 ? 'text-success-600' : 'text-danger-600'}>
              盈亏 {formatCents(latest.gain, { sign: true })}
            </span>
          </div>
        )}
      </div>
      <AnimatePresence mode="wait" initial={false}>
        {isLoading ? (
          <motion.div key="loading" className="h-64 rounded-lg bg-gray-100 animate-pulse" {...cardVariants} />
        ) : isError ? (
          <motion.p key="error" className="text-sm text-danger-600 text-center py-24" {...cardVariants}>
            收益数据加载失败，请刷新页面重试
          </motion.p>
        ) : dates.length > 0 ? (
          <motion.div key="nav" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <EChart echarts={echarts} option={option} style={{ height: 256 }} />
          </motion.div>
        ) : (
          <motion.p key="empty" className="text-sm text-gray-400 text-center py-24" {...cardVariants}>
            暂无交易数据，记录交易后自动生成净值曲线
          </motion.p>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
