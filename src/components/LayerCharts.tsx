import type { Position } from '../types/api';
import type { EChartsOption } from 'echarts';

import ReactECharts from 'echarts-for-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';

import { useLayerPerformance } from '../hooks/usePortfolio';

interface Props {
  positions: Position[];
}

const SAFE_COLOR = '#16a34a';
const AMBITION_COLOR = '#2563eb';

/**
 * 双层账户可视化：
 * - 左：安全层 / 进取层累计收益曲线（交易流水 × 收盘价重放）
 * - 右：进取层持仓份额分布
 */
export default function LayerCharts({ positions }: Props) {
  const { performance, isLoading } = useLayerPerformance();
  const shouldReduceMotion = useReducedMotion() ?? false;

  const ambitionPositions = positions.filter(p => p.layer === 'ambition' && p.market_value > 0);

  const hasSeries = (performance?.safe.length ?? 0) > 0 || (performance?.ambition.length ?? 0) > 0;
  const latestSafeGain = performance?.safe.at(-1)?.cumulative_gain ?? 0;
  const latestAmbitionGain = performance?.ambition.at(-1)?.cumulative_gain ?? 0;
  const chartAnimation = {
    animation: !shouldReduceMotion,
    animationDuration: shouldReduceMotion ? 0 : 700,
    animationDurationUpdate: shouldReduceMotion ? 0 : 350,
    animationEasing: 'cubicOut' as const,
  };

  const lineOption: EChartsOption = {
    ...chartAnimation,
    tooltip: { trigger: 'axis' },
    legend: { data: ['安全层', '进取层'], bottom: 0, icon: 'circle' },
    grid: { left: 8, right: 16, top: 16, bottom: 32, containLabel: true },
    xAxis: { type: 'time' },
    yAxis: { type: 'value', axisLabel: { formatter: '¥{value}' }, splitLine: { lineStyle: { type: 'dashed' } } },
    series: [
      {
        name: '安全层',
        type: 'line',
        showSymbol: false,
        smooth: true,
        itemStyle: { color: SAFE_COLOR },
        lineStyle: { color: SAFE_COLOR, width: 2 },
        areaStyle: { color: SAFE_COLOR, opacity: 0.06 },
        data: (performance?.safe ?? []).map(p => [p.date, p.cumulative_gain]),
      },
      {
        name: '进取层',
        type: 'line',
        showSymbol: false,
        smooth: true,
        itemStyle: { color: AMBITION_COLOR },
        lineStyle: { color: AMBITION_COLOR, width: 2 },
        areaStyle: { color: AMBITION_COLOR, opacity: 0.06 },
        data: (performance?.ambition ?? []).map(p => [p.date, p.cumulative_gain]),
      },
    ],
  };

  const donutOption: EChartsOption = {
    ...chartAnimation,
    tooltip: { trigger: 'item', valueFormatter: (v) => '¥' + Number(v).toFixed(2) },
    legend: { bottom: 0, icon: 'circle' },
    series: [
      {
        name: '进取层持仓',
        type: 'pie',
        radius: ['45%', '68%'],
        center: ['50%', '44%'],
        avoidLabelOverlap: true,
        itemStyle: { borderRadius: 6, borderColor: '#fff', borderWidth: 2 },
        label: { show: false },
        emphasis: { label: { show: true, fontWeight: 'bold' } },
        data: ambitionPositions.map(p => ({ name: p.symbol + ' ' + p.name, value: Math.round(p.market_value * 100) / 100 })),
      },
    ],
  };

  const cardVariants = {
    initial: { opacity: 0, y: shouldReduceMotion ? 0 : 10 },
    animate: { opacity: 1, y: 0, transition: { duration: shouldReduceMotion ? 0 : 0.32 } },
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <motion.div
        className="card"
        variants={cardVariants}
        initial="initial"
        animate="animate"
        whileHover={shouldReduceMotion ? undefined : { y: -2 }}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900">双层累计收益</h3>
          {hasSeries && (
            <div className="flex items-center gap-4 text-xs font-mono">
              <span className={latestSafeGain >= 0 ? 'text-success-600' : 'text-danger-600'}>
                安全层 {latestSafeGain >= 0 ? '+' : ''}{latestSafeGain.toFixed(2)}
              </span>
              <span className={latestAmbitionGain >= 0 ? 'text-primary-600' : 'text-danger-600'}>
                进取层 {latestAmbitionGain >= 0 ? '+' : ''}{latestAmbitionGain.toFixed(2)}
              </span>
            </div>
          )}
        </div>
        <AnimatePresence mode="wait" initial={false}>
          {isLoading ? (
            <motion.div key="loading" className="h-64 rounded-lg bg-gray-100 animate-pulse" {...cardVariants} />
          ) : hasSeries ? (
            <motion.div key="series" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <ReactECharts option={lineOption} style={{ height: 256 }} notMerge />
            </motion.div>
          ) : (
            <motion.p key="empty" className="text-sm text-gray-400 text-center py-24" {...cardVariants}>
              暂无交易数据，记录交易后自动生成收益曲线
            </motion.p>
          )}
        </AnimatePresence>
      </motion.div>

      <motion.div
        className="card"
        variants={cardVariants}
        initial="initial"
        animate="animate"
        transition={{ delay: shouldReduceMotion ? 0 : 0.06 }}
        whileHover={shouldReduceMotion ? undefined : { y: -2 }}
      >
        <h3 className="text-lg font-semibold text-gray-900 mb-4">进取层份额分布</h3>
        <AnimatePresence mode="wait" initial={false}>
          {ambitionPositions.length > 0 ? (
            <motion.div key="positions" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <ReactECharts option={donutOption} style={{ height: 256 }} notMerge />
            </motion.div>
          ) : (
            <motion.p key="empty" className="text-sm text-gray-400 text-center py-24" {...cardVariants}>
              暂无进取层持仓
            </motion.p>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
