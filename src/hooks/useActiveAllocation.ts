import { useState, useEffect, useRef } from 'react';

import { type ActiveAllocation } from '../types/api';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

export function useActiveAllocation(lastEvolution: string | null): {
  activeAllocation: ActiveAllocation | null;
  loading: boolean;
  error: string | null;
} {
  const [activeAllocation, setActiveAllocation] = useState<ActiveAllocation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const prevLastEvolutionRef = useRef(lastEvolution);

  useEffect(() => {
    if (prevLastEvolutionRef.current !== lastEvolution) {
      setLoading(true);
      setError(null);
      prevLastEvolutionRef.current = lastEvolution;
    }

    const controller = new AbortController();
    fetch(`${API_BASE}/api/strategy/latest-params`, { credentials: 'include', signal: controller.signal })
      .then(r => r.json() as Promise<{ success: boolean; data: unknown; message?: string }>)
      .then(json => {
        if (json.success && json.data && typeof json.data === 'object') {
          const d = json.data as Record<string, unknown>;
          if (typeof d.source === 'string' && typeof d.safe_ratio === 'number' && typeof d.ambition_ratio === 'number') {
            setActiveAllocation(d as ActiveAllocation);
            setError(null);
          } else {
            setError('Invalid allocation data');
          }
        } else {
          setError(json.message ?? 'Failed to load allocation');
        }
      })
      .catch((err) => {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          console.error('Failed to fetch latest-params:', err);
          setError('Failed to load allocation');
        }
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [lastEvolution]);

  return { activeAllocation, loading, error };
}
