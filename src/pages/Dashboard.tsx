import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import DepositForm from '../components/DepositForm';
import LayerCharts from '../components/LayerCharts';
import PositionsList from '../components/PositionsList';
import RecentTransactions from '../components/RecentTransactions';
import StrategyEvolutionBar from '../components/StrategyEvolutionBar';
import TransactionForm from '../components/TransactionForm';
import TriggerProgress from '../components/TriggerProgress';
import { useAuth } from '../hooks/useAuth';
import { usePortfolio } from '../hooks/usePortfolio';
import { fadeScaleVariants, staggerContainerVariants, staggerItemVariants } from '../lib/motion';

function DashboardSkeleton() {
  const shouldReduceMotion = useReducedMotion() ?? false;
  const variants = fadeScaleVariants(shouldReduceMotion);

  return (
    <motion.div
      className="min-h-screen bg-gray-50"
      variants={variants}
      initial="initial"
      animate="animate"
      exit="exit"
    >
      <header className="bg-white border-b border-gray-200 h-16" />
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3">
          <div className="h-9 bg-gray-100 rounded-lg animate-pulse" />
        </div>
      </div>
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        <div className="h-36 bg-white rounded-xl border border-gray-200 p-6 animate-pulse">
          <div className="h-5 w-40 bg-gray-100 rounded mb-4" />
          <div className="h-4 bg-gray-100 rounded-full" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {[0, 1, 2].map(i => (
            <div key={i} className="h-24 bg-white rounded-xl border border-gray-200 p-6 animate-pulse">
              <div className="h-4 w-16 bg-gray-100 rounded mb-3" />
              <div className="h-7 w-32 bg-gray-100 rounded" />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {[0, 1].map(i => (
            <div key={i} className="h-72 bg-white rounded-xl border border-gray-200 p-6 animate-pulse">
              <div className="h-5 w-32 bg-gray-100 rounded mb-4" />
              <div className="h-48 bg-gray-100 rounded" />
            </div>
          ))}
        </div>
      </main>
    </motion.div>
  );
}

export default function Dashboard() {
  const { user, logout } = useAuth();
  const { dashboard, isLoading, isError, refetch } = usePortfolio();
  const [activeTab, setActiveTab] = useState<'overview' | 'transactions'>('overview');
  const shouldReduceMotion = useReducedMotion() ?? false;
  const sectionVariants = staggerContainerVariants(shouldReduceMotion);
  const itemVariants = staggerItemVariants(shouldReduceMotion);
  const fadeVariants = fadeScaleVariants(shouldReduceMotion);

  if (isLoading) {
    return <DashboardSkeleton />;
  }

  if (isError || !dashboard) {
    return (
      <motion.div
        className="min-h-screen flex items-center justify-center"
        variants={fadeVariants}
        initial="initial"
        animate="animate"
        exit="exit"
      >
        <div className="text-center">
          <p className="text-danger-600 mb-4">加载数据失败</p>
          <motion.button
            onClick={() => refetch()}
            className="btn-primary"
            whileHover={shouldReduceMotion ? undefined : { y: -1 }}
            whileTap={shouldReduceMotion ? undefined : { scale: 0.98 }}
          >重试</motion.button>
        </div>
      </motion.div>
    );
  }

  const portfolio = dashboard.portfolio;
  const triggerStatus = dashboard.trigger_status;
  const strategyEvolution = dashboard.strategy_evolution;

  const safeHoldings = dashboard.positions.filter(p => p.layer === 'safe').reduce((sum, p) => sum + p.market_value, 0);
  const ambitionHoldings = dashboard.positions.filter(p => p.layer === 'ambition').reduce((sum, p) => sum + p.market_value, 0);
  const totalCash = portfolio?.total_balance ?? 0;
  const safeCash = portfolio?.safe_layer_balance ?? 0;
  const ambitionCash = portfolio?.ambition_layer_balance ?? 0;
  const cardHover = shouldReduceMotion ? undefined : {
    y: -3,
    boxShadow: '0 12px 24px rgba(15, 23, 42, 0.08)',
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
              <h1 className="text-lg font-semibold text-gray-900">Alpha-Life Engine</h1>
            </div>
            <div className="flex items-center gap-4">
              <span className="text-sm text-gray-500 hidden sm:inline">{user?.email}</span>
              <Link to="/reconciliation" className="text-sm text-gray-400 hover:text-gray-600">对账</Link>
              <Link to="/settings" className="text-sm text-gray-400 hover:text-gray-600">设置</Link>
              <motion.button
                onClick={() => logout()}
                className="text-sm text-gray-500 hover:text-gray-700"
                whileHover={shouldReduceMotion ? undefined : { y: -1 }}
                whileTap={shouldReduceMotion ? undefined : { scale: 0.98 }}
              >
                退出登录
              </motion.button>
            </div>
          </div>
        </div>
      </header>

      <motion.div
        className="bg-white border-b border-gray-200"
        variants={itemVariants}
        initial="hidden"
        animate="visible"
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3">
          <StrategyEvolutionBar
            lastEvolution={strategyEvolution.last_evolution}
            daysSince={strategyEvolution.days_since_evolution}
            pboScore={strategyEvolution.pbo_score}
            status={strategyEvolution.status_color}
          />
        </div>
      </motion.div>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <motion.div
          className="mb-8"
          variants={itemVariants}
          initial="hidden"
          animate="visible"
        >
          <TriggerProgress
            currentBalance={triggerStatus.current_balance}
            triggerLine={triggerStatus.trigger_line}
            status={triggerStatus.status}
          />
        </motion.div>

        <div className="mb-6">
          <div className="border-b border-gray-200">
            <nav className="-mb-px flex gap-8" role="tablist" aria-label="仪表盘视图">
              {(['overview', 'transactions'] as const).map(tab => {
                const isActive = activeTab === tab;
                const tabClassName = isActive
                  ? 'relative pb-4 px-1 text-sm font-medium border-b-2 border-transparent text-primary-600'
                  : 'relative pb-4 px-1 text-sm font-medium border-b-2 border-transparent text-gray-500';
                return (
                  <motion.button
                    key={tab}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    onClick={() => setActiveTab(tab)}
                    className={tabClassName}
                    whileHover={shouldReduceMotion ? undefined : { y: -1 }}
                    whileTap={shouldReduceMotion ? undefined : { scale: 0.98 }}
                  >
                    {tab === 'overview' ? '总览' : '交易记录'}
                    {isActive && <motion.span layoutId="dashboard-tab-indicator" className="absolute inset-x-0 bottom-[-2px] h-0.5 bg-primary-600" />}
                  </motion.button>
                );
              })}
            </nav>
          </div>
        </div>

        <AnimatePresence mode="wait" initial={false}>
          {activeTab === 'overview' ? (
            <motion.div
              key="overview"
              className="space-y-6"
              variants={sectionVariants}
              initial="hidden"
              animate="visible"
              exit={{ opacity: 0, transition: { duration: shouldReduceMotion ? 0 : 0.16 } }}
            >
              <motion.div className="grid grid-cols-1 md:grid-cols-3 gap-6" variants={sectionVariants}>
                <motion.div className="card" variants={itemVariants} whileHover={cardHover}>
                  <p className="text-sm text-gray-500 mb-1">总资产</p>
                  <p className="text-2xl font-bold text-gray-900">¥{(totalCash + safeHoldings + ambitionHoldings).toFixed(2)}</p>
                  <p className="text-xs text-gray-400 mt-1 font-mono">现金 ¥{totalCash.toFixed(2)} · 持仓 ¥{(safeHoldings + ambitionHoldings).toFixed(2)}</p>
                </motion.div>
                <motion.div className="card" variants={itemVariants} whileHover={cardHover}>
                  <p className="text-sm text-gray-500 mb-1">安全层</p>
                  <p className="text-2xl font-bold text-success-600">¥{(safeCash + safeHoldings).toFixed(2)}</p>
                  <p className="text-xs text-gray-400 mt-1 font-mono">现金 ¥{safeCash.toFixed(2)} · 持仓 ¥{safeHoldings.toFixed(2)}</p>
                </motion.div>
                <motion.div className="card" variants={itemVariants} whileHover={cardHover}>
                  <p className="text-sm text-gray-500 mb-1">进取层</p>
                  <p className="text-2xl font-bold text-primary-600">¥{(ambitionCash + ambitionHoldings).toFixed(2)}</p>
                  <p className="text-xs text-gray-400 mt-1 font-mono">现金 ¥{ambitionCash.toFixed(2)} · 持仓 ¥{ambitionHoldings.toFixed(2)}</p>
                </motion.div>
              </motion.div>
              <motion.div variants={itemVariants}>
                <LayerCharts positions={dashboard.positions} />
              </motion.div>
              <motion.div variants={itemVariants}>
                <PositionsList positions={dashboard.positions} />
              </motion.div>
              <motion.div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start" variants={sectionVariants}>
                <motion.div variants={itemVariants}>
                  <DepositForm lastEvolution={strategyEvolution.last_evolution} onSuccess={() => refetch()} />
                </motion.div>
                <motion.div variants={itemVariants}>
                  <TransactionForm onSuccess={() => refetch()} />
                </motion.div>
              </motion.div>
            </motion.div>
          ) : (
            <motion.div
              key="transactions"
              variants={fadeVariants}
              initial="initial"
              animate="animate"
              exit="exit"
            >
              <RecentTransactions transactions={dashboard.recent_transactions} />
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}
