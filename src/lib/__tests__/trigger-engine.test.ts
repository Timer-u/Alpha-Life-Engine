import type { ActiveAllocation, TriggerInput } from '../../types/api';

import { describe, expect, it } from 'vitest';

import { triggerEngine } from '../trigger-engine';

const input: TriggerInput = { user_id: 1, current_balance: 200000, signal_value: 2.0, signal_type: 'BSM' };

describe('trigger engine ETF rotation', () => {
  it('picks the highest-weight safe ETF from an array allocation', () => {
    const evolved: ActiveAllocation = {
      source: 'evolved',
      safe_allocation: [{ symbol: '511990', weight: 0.6 }, { symbol: '511360', weight: 0.4 }],
    };
    const res = triggerEngine.makeTriggerDecision(input, {}, evolved);
    expect(res.next_safe_etf).toBe('511990');
  });

  it('picks the highest-weight ambition ETF from a dict allocation', () => {
    const evolved: ActiveAllocation = {
      source: 'evolved',
      ambition_allocation: Object.entries({ '510500': 0.7, '510300': 0.3 }).map(([symbol, weight]) => ({ symbol, weight })),
    };
    const res = triggerEngine.makeTriggerDecision(input, {}, evolved);
    expect(res.next_ambition_etf).toBe('510500');
  });

  it('falls back to primary ETF when allocation is missing or empty', () => {
    const none = triggerEngine.makeTriggerDecision(input, {}, null);
    expect(none.next_safe_etf).toBe('511360');
    expect(none.next_ambition_etf).toBe('510300');

    const empty: ActiveAllocation = { source: 'evolved', safe_allocation: [], ambition_allocation: [] };
    const res = triggerEngine.makeTriggerDecision(input, {}, empty);
    expect(res.next_safe_etf).toBe('511360');
    expect(res.next_ambition_etf).toBe('510300');
  });

  it('tie breaks to the first entry', () => {
    const evolved: ActiveAllocation = {
      source: 'evolved',
      safe_allocation: [{ symbol: '511880', weight: 0.5 }, { symbol: '511360', weight: 0.5 }],
    };
    const res = triggerEngine.makeTriggerDecision(input, {}, evolved);
    expect(res.next_safe_etf).toBe('511880');
  });

  it('market_data carries the chosen ETFs', () => {
    const evolved: ActiveAllocation = {
      source: 'evolved',
      safe_allocation: [{ symbol: '511990', weight: 0.6 }, { symbol: '511360', weight: 0.4 }],
      ambition_allocation: [{ symbol: '510500', weight: 0.7 }, { symbol: '510300', weight: 0.3 }],
    };
    const res = triggerEngine.makeTriggerDecision(input, { '511990': 1.5, '510500': 2.1 }, evolved);
    expect(res.market_data).toEqual({ '511990': 1.5, '510500': 2.1 });
  });
});
