import type { ActiveAllocation } from '../../src/types/api';
import type { D1Database } from '@cloudflare/workers-types';

import { calculateLCHAllocation } from '../../src/lib/lch-allocation';

export interface ResolveActiveParamsResult {
  allocation: ActiveAllocation | null;
  pboRejected?: boolean;
  pboScore?: number | null;
}

type D1Db = D1Database;

const PBO_REJECT_THRESHOLD = 0.5;

function parseBirthPrefs(prefsJson: string | null): { birthYear: number | null; birthMonth: number; birthDay: number } {
  if (!prefsJson) return { birthYear: null, birthMonth: 6, birthDay: 15 };
  try {
    const prefs = JSON.parse(prefsJson);
    return {
      birthYear: typeof prefs.birth_year === 'number' ? prefs.birth_year : null,
      birthMonth: typeof prefs.birth_month === 'number' ? prefs.birth_month : 6,
      birthDay: typeof prefs.birth_day === 'number' ? prefs.birth_day : 15,
    };
  } catch {
    return { birthYear: null, birthMonth: 6, birthDay: 15 };
  }
}

function lchFallback(birthYear: number | null, birthMonth: number, birthDay: number): ActiveAllocation | null {
  const year = birthYear ?? new Date().getFullYear() - 20;
  return calculateLCHAllocation(year, birthMonth, birthDay);
}

export async function resolveActiveParams(db: D1Db, userId: number): Promise<ResolveActiveParamsResult> {
  const user = await db.prepare(
    'SELECT preferences FROM users WHERE id = ?'
  ).bind(userId).first<{ preferences: string | null }>();

  const { birthYear, birthMonth, birthDay } = parseBirthPrefs(user?.preferences ?? null);

  const report = await db.prepare(
    `SELECT report_data, pbo_score, dsr_ranking, evolution_timestamp
     FROM strategy_reports WHERE user_id = ? ORDER BY evolution_timestamp DESC LIMIT 1`
  ).bind(userId).first<{
    report_data: string;
    pbo_score: number | null;
    dsr_ranking: number | null;
    evolution_timestamp: string;
  }>();

  if (!report) {
    return { allocation: lchFallback(birthYear, birthMonth, birthDay) };
  }

  if (report.pbo_score !== null && report.pbo_score > PBO_REJECT_THRESHOLD) {
    return { allocation: lchFallback(birthYear, birthMonth, birthDay), pboRejected: true, pboScore: report.pbo_score };
  }

  let parsed: { recommended_params?: Record<string, unknown> };
  try {
    parsed = JSON.parse(report.report_data);
  } catch {
    return { allocation: lchFallback(birthYear, birthMonth, birthDay) };
  }

  const p = parsed.recommended_params;
  if (!p || typeof p.trigger_line !== 'number') {
    return { allocation: lchFallback(birthYear, birthMonth, birthDay) };
  }

  const lch = birthYear ? calculateLCHAllocation(birthYear, birthMonth, birthDay) : null;
  const safeRatio = typeof p.safe_ratio === 'number' ? p.safe_ratio : (lch?.safe_ratio ?? 0.6);
  const ambitionRatio = typeof p.ambition_ratio === 'number' ? p.ambition_ratio : (lch?.ambition_ratio ?? 0.4);
  const bsmThreshold = typeof p.bsm_threshold === 'number' ? p.bsm_threshold : 1.4;
  const maShort = typeof p.ma_short_window === 'number' ? p.ma_short_window : 20;
  const maLong = typeof p.ma_long_window === 'number' ? p.ma_long_window : 60;
  const safeAlloc = Array.isArray(p.safe_allocation) ? p.safe_allocation as Array<{symbol: string; weight: number}> : [{ symbol: '511360', weight: 1.0 }];
  const ambitionAlloc = Array.isArray(p.ambition_allocation) ? p.ambition_allocation as Array<{symbol: string; weight: number}> : [{ symbol: '000300', weight: 1.0 }];

  return {
    allocation: {
      trigger_line: p.trigger_line,
      safe_ratio: safeRatio,
      ambition_ratio: ambitionRatio,
      bsm_threshold: bsmThreshold,
      ma_short_window: maShort,
      ma_long_window: maLong,
      safe_allocation: safeAlloc,
      ambition_allocation: ambitionAlloc,
      evolution_timestamp: report.evolution_timestamp,
      pbo_score: report.pbo_score,
      dsr_ranking: report.dsr_ranking,
      source: 'evolved',
    },
  };
}
