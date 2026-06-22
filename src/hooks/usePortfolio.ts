import { useQuery, useMutation } from '@tanstack/react-query';
import type { DashboardData, TransactionForm, ApiResponse, Transaction } from '../types/api';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

function isDashboardData(obj: unknown): obj is DashboardData {
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  return (
    'portfolio' in o &&
    'positions' in o &&
    'recent_transactions' in o &&
    'trigger_status' in o &&
    'strategy_evolution' in o
  );
}

function isApiResponse(obj: unknown): obj is ApiResponse<unknown> {
  return (
    obj !== null &&
    typeof obj === 'object' &&
    'success' in obj &&
    typeof (obj as Record<string, unknown>).success === 'boolean'
  );
}

async function fetchDashboard(): Promise<DashboardData> {
  const res = await fetch(`${API_BASE}/api/portfolio`, { credentials: 'include' });
  if (res.status === 401) {
    throw new Error('UNAUTHORIZED');
  }
  if (!res.ok) {
    throw new Error('获取数据失败');
  }
  const json = (await res.json()) as unknown;
  if (!isApiResponse(json) || !json.success) {
    throw new Error('Invalid response');
  }
  if (!isDashboardData(json.data)) {
    throw new Error('Invalid dashboard data');
  }
  return json.data;
}

async function createTransaction(form: TransactionForm): Promise<Transaction> {
  const res = await fetch(`${API_BASE}/api/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(form),
  });
  const json = (await res.json()) as unknown;
  if (!isApiResponse(json) || !json.success) {
    const msg =
      json && typeof json === 'object' && 'message' in json
        ? String(json.message)
        : '创建交易失败';
    throw new Error(msg);
  }
  const data = json.data as Record<string, unknown> | undefined;
  if (!data || typeof data.id !== 'number') {
    throw new Error('Invalid transaction data');
  }
  return data as unknown as Transaction;
}

async function calculateCommission(amount: number): Promise<{
  commission: number;
  amount: number;
  commission_rate: number;
  commission_min: number;
}> {
  const res = await fetch(`${API_BASE}/api/transactions/calculate-commission`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ amount }),
  });
  const json = (await res.json()) as unknown;
  if (!isApiResponse(json) || !json.success) {
    throw new Error('计算佣金失败');
  }
  const data = json.data as Record<string, unknown> | undefined;
  if (!data || typeof data.commission !== 'number') {
    throw new Error('Invalid commission data');
  }
  return data as {
    commission: number;
    amount: number;
    commission_rate: number;
    commission_min: number;
  };
}

export function usePortfolio() {
  const dashboardQuery = useQuery({
    queryKey: ['portfolio', 'dashboard'],
    queryFn: fetchDashboard,
    retry: (failureCount, error) => {
      if (error instanceof Error && error.message === 'UNAUTHORIZED') return false;
      return failureCount < 3;
    },
  });

  const createTransactionMutation = useMutation({
    mutationFn: createTransaction,
  });

  return {
    dashboard: dashboardQuery.data,
    isLoading: dashboardQuery.isLoading,
    isError: dashboardQuery.isError,
    error: dashboardQuery.error,
    refetch: dashboardQuery.refetch,
    createTransaction: createTransactionMutation.mutateAsync,
    isCreating: createTransactionMutation.isPending,
    calculateCommission,
  };
}
