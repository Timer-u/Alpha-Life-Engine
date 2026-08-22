import type { Position } from '../types/api';

import { motion, useReducedMotion } from 'motion/react';

import { formatCents } from '../lib/money';

interface Props { positions: Position[]; }

/** 浮动盈亏（分） = (现价 − 含佣均价) × 股数 */
function floatingPnlCents(position: Position): number {
  return Math.round((position.current_price - position.avg_price) * position.shares * 100);
}

export default function PositionsList({ positions }: Props) {
  const shouldReduceMotion = useReducedMotion() ?? false;
  const safePositions = positions.filter(p => p.layer === 'safe');
  const ambitionPositions = positions.filter(p => p.layer === 'ambition');
  const containerVariants = {
    hidden: { opacity: 1 },
    visible: {
      opacity: 1,
      transition: { staggerChildren: shouldReduceMotion ? 0 : 0.06 },
    },
  };
  const itemVariants = {
    hidden: { opacity: 0, y: shouldReduceMotion ? 0 : 10 },
    visible: { opacity: 1, y: 0, transition: { duration: shouldReduceMotion ? 0 : 0.26 } },
  };
  const cardHover = shouldReduceMotion ? undefined : { y: -2, boxShadow: '0 10px 20px rgba(15, 23, 42, 0.06)' };

  const renderCard = (position: Position) => {
    const pnl = floatingPnlCents(position);
    const pnlClassName = pnl > 0 ? 'text-success-600' : pnl < 0 ? 'text-danger-600' : 'text-gray-400';
    return (
      <motion.div
        key={position.id}
        variants={itemVariants}
        whileHover={cardHover}
        className="flex items-center justify-between p-4 bg-gray-50 rounded-lg transition-colors hover:bg-gray-100"
      >
        <div>
          <p className="font-medium text-gray-900">{position.symbol}</p>
          <p className="text-sm text-gray-500">{position.name}</p>
        </div>
        <div className="text-right">
          <p className="font-medium text-gray-900">{position.shares.toFixed(3)} 股</p>
          <p className="text-sm text-gray-500">均价 ¥{position.avg_price.toFixed(2)} · 市值 {formatCents(position.market_value)}</p>
          <p className={'text-sm font-medium ' + pnlClassName}>
            盈亏 {formatCents(pnl, { sign: true })}
          </p>
        </div>
      </motion.div>
    );
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <motion.div className="card" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: shouldReduceMotion ? 0 : 0.3 }}>
        <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <motion.span className="w-2 h-2 rounded-full bg-success-500" animate={shouldReduceMotion ? undefined : { scale: [1, 1.2, 1] }} transition={shouldReduceMotion ? undefined : { duration: 1.8, repeat: Infinity }} />安全层持仓
        </h3>
        {safePositions.length > 0 ? (
          <motion.div className="space-y-3" variants={containerVariants} initial="hidden" animate="visible">
            {safePositions.map(renderCard)}
          </motion.div>
        ) : (
          <motion.p className="text-sm text-gray-400 text-center py-8" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>暂无持仓</motion.p>
        )}
      </motion.div>
      <motion.div className="card" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: shouldReduceMotion ? 0 : 0.3, delay: shouldReduceMotion ? 0 : 0.06 }}>
        <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <motion.span className="w-2 h-2 rounded-full bg-primary-500" animate={shouldReduceMotion ? undefined : { scale: [1, 1.2, 1] }} transition={shouldReduceMotion ? undefined : { duration: 1.8, repeat: Infinity, delay: 0.2 }} />进取层持仓
        </h3>
        {ambitionPositions.length > 0 ? (
          <motion.div className="space-y-3" variants={containerVariants} initial="hidden" animate="visible">
            {ambitionPositions.map(renderCard)}
          </motion.div>
        ) : (
          <motion.p className="text-sm text-gray-400 text-center py-8" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>暂无持仓</motion.p>
        )}
      </motion.div>
    </div>
  );
}
