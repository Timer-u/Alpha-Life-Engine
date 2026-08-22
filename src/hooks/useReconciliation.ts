import type { Reconciliation, ReconciliationComparison } from '../types/api';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch, retryExceptUnauthorized } from '../lib/api';
import { isApiResponse } from '../types/api';

// All money fields below (broker_balance / deposits / withdrawals / gains / fees)
// are integer CENTS. The Reconciliation page converts yuan inputs before calling create.
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
  /** 校准核对提示（差额去向、持仓构成仍需人工核对等），UI 必须展示 */
  warnings: string[];
  message: string;
}

function extractMessage(json: unknown, fallback: string): string {
  return json && typeof json === 'object' && 'message' in json && typeof (json as Record<string, unknown>).message === 'string'
    ? String((json as Record<string, unknown>).message)
    : fallback;
}

async function fetchReconciliations(): Promise<Reconciliation[]> {
  const json = (await apiFetch('/api/reconciliation')) as unknown;
  if (!isApiResponse(json) || !json.success || !Array.isArray(json.data)) {
    throw new Error(extractMessage(json, '获取对账记录失败'));
  }
  return json.data as Reconciliation[];
}

async function createReconciliation(input: CreateReconciliationInput): Promise<CreateReconciliationResult> {
  const json = (await apiFetch('/api/reconciliation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })) as unknown;
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
  const json = (await apiFetch(`/api/reconciliation/${id}/calibrate`, {
    method: 'POST',
  })) as unknown;
  if (!isApiResponse(json) || !json.success) {
    throw new Error(extractMessage(json, '校准失败'));
  }
  const data = json.data as (Omit<CalibrateResult, 'message' | 'warnings'> & { warnings?: unknown }) | undefined;
  if (!data || typeof data.system_total !== 'number') {
    throw new Error('Invalid calibrate data');
  }
  return {
    ...data,
    warnings: Array.isArray(data.warnings) ? data.warnings.filter((w): w is string => typeof w === 'string') : [],
    message: extractMessage(json, '校准完成'),
  };
}

export function useReconciliation() {
  const queryClient = useQueryClient();

  const listQuery = useQuery({
    queryKey: ['reconciliation', 'list'],
    queryFn: fetchReconciliations,
    retry: retryExceptUnauthorized,
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
