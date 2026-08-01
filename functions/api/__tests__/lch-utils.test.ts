import { describe, expect, it } from 'vitest';

import { resolveActiveParams } from '../lch-utils';

import { asD1, FakeD1 } from './helpers/fake-d1';

const USER_PREFS = '{"birth_year":1990,"birth_month":6,"birth_day":15}';

function dbWithReport(safeRatio: number, daysAgo: number): FakeD1 {
  const ts = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  return new FakeD1([
    { match: sql => sql.includes('FROM users'), rows: [{ preferences: USER_PREFS }] },
    {
      match: sql => sql.includes('FROM strategy_reports'),
      rows: [{
        report_data: JSON.stringify({
          recommended_params: { trigger_line: 1667, safe_ratio: safeRatio, ambition_ratio: 0.4 },
        }),
        pbo_score: null,
        dsr_ranking: null,
        evolution_timestamp: ts,
      }],
    },
  ]);
}

describe('resolveActiveParams', () => {
  it('clamps evolved safe_ratio above 1 down to 1', async () => {
    const { allocation } = await resolveActiveParams(asD1(dbWithReport(2.0, 7)), 1);
    expect(allocation?.safe_ratio).toBe(1);
  });

  it('clamps evolved safe_ratio below 0 up to 0', async () => {
    const { allocation } = await resolveActiveParams(asD1(dbWithReport(-0.5, 7)), 1);
    expect(allocation?.safe_ratio).toBe(0);
  });

  it('keeps evolved safe_ratio within [0,1] unchanged', async () => {
    const { allocation } = await resolveActiveParams(asD1(dbWithReport(0.6, 7)), 1);
    expect(allocation?.safe_ratio).toBe(0.6);
  });

  it('falls back to LCH allocation for stale reports older than 45 days', async () => {
    const { allocation, staleReport } = await resolveActiveParams(asD1(dbWithReport(0.6, 60)), 1);
    expect(staleReport).toBe(true);
    expect(allocation?.source).toBe('lch');
  });

  it('keeps evolved allocation for fresh reports', async () => {
    const { allocation, staleReport } = await resolveActiveParams(asD1(dbWithReport(0.6, 7)), 1);
    expect(staleReport).toBeUndefined();
    expect(allocation?.source).toBe('evolved');
  });
});
