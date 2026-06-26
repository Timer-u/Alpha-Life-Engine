import { useState } from 'react';

import PositionsList from '../components/PositionsList';
import RecentTransactions from '../components/RecentTransactions';
import StrategyEvolutionBar from '../components/StrategyEvolutionBar';
import TransactionForm from '../components/TransactionForm';
import TriggerProgress from '../components/TriggerProgress';
import { useAuth } from '../hooks/useAuth';
import { usePortfolio } from '../hooks/usePortfolio';

export default function Dashboard() {
  const { user, logout } = useAuth();
  const { dashboard, isLoading, isError, refetch } = usePortfolio();
  const [activeTab, setActiveTab] = useState<'overview' | 'transactions'>('overview');

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600" />
      </div>
    );
  }

  if (isError || !dashboard) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <p className="text-danger-600 mb-4">加载数据失败</p>
          <button onClick={() => refetch()} className="btn-primary">重试</button>
        </div>
      </div>
    );
  }

  const portfolio = dashboard.portfolio;
  const triggerStatus = dashboard.trigger_status;
  const strategyEvolution = dashboard.strategy_evolution;

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
              <a href="/settings" className="text-sm text-gray-400 hover:text-gray-600">设置</a>
              <button onClick={() => logout()} className="text-sm text-gray-500 hover:text-gray-700">
                退出登录
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3">
          <StrategyEvolutionBar
            lastEvolution={strategyEvolution.last_evolution}
            daysSince={strategyEvolution.days_since_evolution}
            pboScore={strategyEvolution.pbo_score}
            status={strategyEvolution.status_color}
          />
        </div>
      </div>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <TriggerProgress
            currentBalance={triggerStatus.current_balance}
            triggerLine={triggerStatus.trigger_line}
            status={triggerStatus.status}
          />
        </div>

        <div className="mb-6">
          <div className="border-b border-gray-200">
            <nav className="-mb-px flex gap-8">
              <button onClick={() => setActiveTab('overview')}
                className={`pb-4 px-1 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === 'overview' ? 'border-primary-600 text-primary-600' : 'border-transparent text-gray-500'
                }`}>总览</button>
              <button onClick={() => setActiveTab('transactions')}
                className={`pb-4 px-1 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === 'transactions' ? 'border-primary-600 text-primary-600' : 'border-transparent text-gray-500'
                }`}>交易记录</button>
            </nav>
          </div>
        </div>

        {activeTab === 'overview' ? (
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="card">
                <p className="text-sm text-gray-500 mb-1">总资产</p>
                <p className="text-2xl font-bold text-gray-900">¥{portfolio?.total_balance.toFixed(2) ?? '0.00'}</p>
              </div>
              <div className="card">
                <p className="text-sm text-gray-500 mb-1">安全层</p>
                <p className="text-2xl font-bold text-success-600">¥{portfolio?.safe_layer_balance.toFixed(2) ?? '0.00'}</p>
              </div>
              <div className="card">
                <p className="text-sm text-gray-500 mb-1">进取层</p>
                <p className="text-2xl font-bold text-primary-600">¥{portfolio?.ambition_layer_balance.toFixed(2) ?? '0.00'}</p>
              </div>
            </div>
            <PositionsList positions={dashboard.positions} />
            <TransactionForm onSuccess={() => refetch()} />
          </div>
        ) : (
          <RecentTransactions transactions={dashboard.recent_transactions} />
        )}
      </main>
    </div>
  );
}
