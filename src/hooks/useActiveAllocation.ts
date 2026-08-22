import { useQuery } from '@tanstack/react-query';

import { apiFetch, retryExceptUnauthorized } from '../lib/api';
import { type ActiveAllocation } from '../types/api';

function isAllocation(obj: unknown): obj is ActiveAllocation {
  if (!obj || typeof obj !== 'object') return false;
  const d = obj as Record<string, unknown>;
  return typeof d.source === 'string' && typeof d.safe_ratio === 'number' && typeof d.ambition_ratio === 'number';
}

/**
 * 当前生效的分配参数（演化策略或 LCH 兜底）。
 *
 * React Query 共享缓存：充值表单与策略条同时挂载时只发一次请求，
 * 顺带消除旧实现 abort 后 finally 仍置 loading 的竞态。
 */
export function useActiveAllocation(_lastEvolution?: string | null): {
  activeAllocation: ActiveAllocation | null;
  loading: boolean;
  error: string | null;
} {
  const query = useQuery({
    queryKey: ['strategy', 'latest-params'],
    queryFn: async (): Promise<ActiveAllocation | null> => {
      const json = (await apiFetch('/api/strategy/latest-params')) as
        | { success: boolean; data?: unknown; message?: string }
        | null;
      if (!json?.success) {
        throw new Error(json?.message ?? '获取分配参数失败');
      }
      if (json.data === null) return null;
      if (!isAllocation(json.data)) {
        throw new Error('Invalid allocation data');
      }
      return json.data;
    },
    retry: retryExceptUnauthorized,
  });

  return {
    activeAllocation: query.data ?? null,
    loading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : query.error ? '获取分配参数失败' : null,
  };
}
