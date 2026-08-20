import { describe, expect, it } from 'vitest';

import {
  asiaShanghaiDate,
  detectMissingTradingDays,
  isTradingDay,
  lastTradingDayOnOrBefore,
  shiftDate,
  tradingDaysBetween,
} from '../trading-calendar';

describe('isTradingDay', () => {
  it('returns false on weekends', () => {
    expect(isTradingDay('2026-08-15')).toBe(false); // Saturday
    expect(isTradingDay('2026-08-16')).toBe(false); // Sunday
  });

  it('returns false on a known Chinese holiday', () => {
    expect(isTradingDay('2026-02-17')).toBe(false); // 春节 2026 (pick from the generated JSON if different)
  });

  it('returns true on a normal weekday', () => {
    expect(isTradingDay('2026-08-19')).toBe(true);
  });

  it('falls back to weekday approximation beyond the calendar', () => {
    expect(isTradingDay('2027-01-04')).toBe(true); // Monday, past `through` (2026-12-31)
    expect(isTradingDay('2028-01-04')).toBe(true); // beyond `through`, Tuesday
    expect(isTradingDay('2028-01-01')).toBe(false); // Saturday
  });
});

describe('lastTradingDayOnOrBefore / tradingDaysBetween', () => {
  it('skips weekends and holidays', () => {
    expect(lastTradingDayOnOrBefore('2026-08-16')).toBe('2026-08-14'); // Sunday -> Friday
    const gap = tradingDaysBetween('2026-02-13', '2026-02-18');
    expect(gap).not.toContain('2026-02-14');
    expect(gap).not.toContain('2026-02-17'); // 春节
  });

  it('returns the earliest trading day at the lower boundary', () => {
    expect(lastTradingDayOnOrBefore('2013-01-04')).toBe('2013-01-04');
  });

  it('throws for a date before the earliest supported trading day (no loop)', () => {
    expect(() => lastTradingDayOnOrBefore('2013-01-03')).toThrow('earliest supported trading day is 2013-01-04');
    expect(() => lastTradingDayOnOrBefore('2012-12-31')).toThrow('earliest supported trading day is 2013-01-04');
  });
});

describe('detectMissingTradingDays', () => {
  it('warns for symbols missing the latest trading day', () => {
    const lines = detectMissingTradingDays({ '511360': '2026-08-10' }, '2026-08-14');
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('511360');
    expect(lines[0]).toContain('2026-08-11');
  });

  it('stays silent when data is current', () => {
    expect(detectMissingTradingDays({ '511360': '2026-08-14' }, '2026-08-14')).toEqual([]);
  });
});

describe('asiaShanghaiDate / shiftDate', () => {
  it('converts UTC to Shanghai date and shifts calendar days', () => {
    expect(asiaShanghaiDate(new Date('2026-08-14T16:00:00.000Z'))).toBe('2026-08-15');
    expect(shiftDate('2026-08-14', -1)).toBe('2026-08-13');
  });
});
