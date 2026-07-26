import type { Reconciliation, ReconciliationComparison } from '../types/api';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { isApiResponse } from '../types/api';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

export interface CreateReconciliationInput {
  reconciliation_date: string;
  broker_balance: number;
  deposits?: number;
  withdrawals?: number;
  gains?: number;
  fees?: number;
  notes?: string;
}

export interface CreateReconciliationResult {
  reconciliation: Reconciliation;
  comparison: ReconciliationComparison;
  message: string;
}

export interface CalibrateResult {
  portfolio: {
    total_balance: number;
    safe_layer_balance: number;
    ambition_layer_balance: number;
  };
  holdings_value: number;
  system_total: number;
  message: string;
}

function extractMessage(json: unknown, fallback: string): string {
  return json && typeof json === 'object' && 'message' in json && typeof (json as Record<string, unknown>).message === 'string'
    ? String((json as Record<string, unknown>).message)
    : fallback;
}

async function fetchReconciliations(): Promise<Reconciliation[]> {
  const res = await fetch(`${API_BASE}/api/reconciliation`, { credentials: 'include' });
  const json = (await res.json()) as unknown;
  if (!isApiResponse(json) || !json.success || !Array.isArray(json.data)) {
    throw new Error(extractMessage(json, '获取对账记录失败'));
  }
  return json.data as Reconciliation[];
}

async function createReconciliation(input: CreateReconciliationInput): Promise<CreateReconciliationResult> {
  const res = await fetch(`${API_BASE}/api/reconciliation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(input),
  });
  const json = (await res.json()) as unknown;
  if (!isApiResponse(json) || !json.success) {
    throw new Error(extractMessage(json, '对账失败'));
  }
  const data = json.data as { reconciliation: Reconciliation; comparison: ReconciliationComparison } | undefined;
  if (!data || typeof data.reconciliation !== 'object' || typeof data.comparison !== 'object') {
    throw new Error('Invalid reconciliation data');
  }
  return { ...data, message: extractMessage(json, '对账完成') };
}

async function calibrateReconciliation(id: number): Promise<CalibrateResult> {
  const res = await fetch(`${API_BASE}/api/reconciliation/${id}/calibrate`, {
    method: 'POST',
    credentials: 'include',
  });
  const json = (await res.json()) as unknown;
  if (!isApiResponse(json) || !json.success) {
    throw new Error(extractMessage(json, '校准失败'));
  }
  const data = json.data as Omit<CalibrateResult, 'message'> | undefined;
  if (!data || typeof data.system_total !== 'number') {
    throw new Error('Invalid calibrate data');
  }
  return { ...data, message: extractMessage(json, '校准完成') };
}

export function useReconciliation() {
  const queryClient = useQueryClient();

  const listQuery = useQuery({
    queryKey: ['reconciliation', 'list'],
    queryFn: fetchReconciliations,
  });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['reconciliation'] });
    await queryClient.invalidateQueries({ queryKey: ['portfolio'] });
  };

  const createMutation = useMutation({
    mutationFn: createReconciliation,
    onSuccess: invalidate,
  });

  const calibrateMutation = useMutation({
    mutationFn: calibrateReconciliation,
    onSuccess: invalidate,
  });

  return {
    reconciliations: listQuery.data ?? [],
    isLoading: listQuery.isLoading,
    isError: listQuery.isError,
    create: createMutation.mutateAsync,
    isCreating: createMutation.isPending,
    calibrate: calibrateMutation.mutateAsync,
    isCalibrating: calibrateMutation.isPending,
  };
}
