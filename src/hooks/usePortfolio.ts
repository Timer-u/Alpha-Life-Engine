import type { DashboardData, DepositResult, LayerPerformance, TransactionForm, Transaction } from '../types/api';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import { isApiResponse } from '../types/api';

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
  amount_cents: number;
  commission_cents: number;
  commission_rate: number;
  commission_min_cents: number;
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
  if (!data || typeof data.commission_cents !== 'number') {
    throw new Error('Invalid commission data');
  }
  return data as {
    amount_cents: number;
    commission_cents: number;
    commission_rate: number;
    commission_min_cents: number;
  };
}

async function depositFunds(
  amountCents: number,
  idempotencyKey: string
): Promise<DepositResult & { message: string }> {
  const res = await fetch(`${API_BASE}/api/portfolio/deposit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ amount_cents: amountCents, idempotency_key: idempotencyKey }),
  });
  const json = (await res.json()) as unknown;
  if (!isApiResponse(json) || !json.success) {
    const msg =
      json && typeof json === 'object' && 'message' in json
        ? String(json.message)
        : '充值失败';
    throw new Error(msg);
  }
  const data = json.data as Record<string, unknown> | undefined;
  if (!data || typeof data.amount_cents !== 'number' || typeof data.duplicate !== 'boolean') {
    throw new Error('Invalid deposit data');
  }
  const message = 'message' in json && typeof json.message === 'string' ? json.message : '充值成功';
  return { ...(data as unknown as DepositResult), message };
}

function isLayerPerformance(obj: unknown): obj is LayerPerformance {
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  return Array.isArray(o.safe) && Array.isArray(o.ambition);
}

async function fetchLayerPerformance(): Promise<LayerPerformance> {
  const res = await fetch(`${API_BASE}/api/portfolio/layer-performance`, { credentials: 'include' });
  if (res.status === 401) {
    throw new Error('UNAUTHORIZED');
  }
  const json = (await res.json()) as unknown;
  if (!isApiResponse(json) || !json.success || !isLayerPerformance(json.data)) {
    throw new Error('获取收益数据失败');
  }
  return json.data;
}

export function useLayerPerformance() {
  const query = useQuery({
    queryKey: ['portfolio', 'layer-performance'],
    queryFn: fetchLayerPerformance,
    retry: (failureCount, error) => {
      if (error instanceof Error && error.message === 'UNAUTHORIZED') return false;
      return failureCount < 3;
    },
  });

  return {
    performance: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

export function usePortfolio() {
  const queryClient = useQueryClient();

  const dashboardQuery = useQuery({
    queryKey: ['portfolio', 'dashboard'],
    queryFn: fetchDashboard,
    retry: (failureCount, error) => {
      if (error instanceof Error && error.message === 'UNAUTHORIZED') return false;
      return failureCount < 3;
    },
  });

  const invalidatePortfolio = async () => {
    await queryClient.invalidateQueries({ queryKey: ['portfolio'] });
  };

  const createTransactionMutation = useMutation({
    mutationFn: createTransaction,
    onSuccess: invalidatePortfolio,
  });

  const depositMutation = useMutation({
    mutationFn: ({ amountCents, idempotencyKey }: { amountCents: number; idempotencyKey: string }) =>
      depositFunds(amountCents, idempotencyKey),
    onSuccess: invalidatePortfolio,
  });

  return {
    dashboard: dashboardQuery.data,
    isLoading: dashboardQuery.isLoading,
    isError: dashboardQuery.isError,
    error: dashboardQuery.error,
    refetch: dashboardQuery.refetch,
    createTransaction: createTransactionMutation.mutateAsync,
    isCreating: createTransactionMutation.isPending,
    deposit: depositMutation.mutateAsync,
    isDepositing: depositMutation.isPending,
    calculateCommission,
  };
}
