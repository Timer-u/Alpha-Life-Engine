import { describe, expect, it } from 'vitest';

import { centsToYuan, formatCents, splitDepositCents, tradeDateShanghai, yuanToCents } from '../money';

describe('yuanToCents', () => {
  it('converts yuan to cents with rounding', () => {
    expect(yuanToCents(10)).toBe(1000);
    expect(yuanToCents(0.1)).toBe(10);
    expect(yuanToCents(0.1 + 0.2)).toBe(30);
    expect(yuanToCents(1667)).toBe(166700);
  });
});

describe('centsToYuan', () => {
  it('converts cents to yuan', () => {
    expect(centsToYuan(1000)).toBe(10);
    expect(centsToYuan(30)).toBe(0.3);
  });
});

describe('formatCents', () => {
  it('formats cents as yuan with symbol', () => {
    expect(formatCents(123456)).toBe('¥1,234.56');
    expect(formatCents(0)).toBe('¥0.00');
    expect(formatCents(150, { sign: true })).toBe('+¥1.50');
    expect(formatCents(-150, { sign: true })).toBe('-¥1.50');
  });
});

describe('tradeDateShanghai', () => {
  it('returns Asia/Shanghai date', () => {
    expect(tradeDateShanghai(new Date('2026-08-14T16:00:00.000Z'))).toBe('2026-08-15');
    expect(tradeDateShanghai(new Date('2026-08-14T03:00:00.000Z'))).toBe('2026-08-14');
  });
});

describe('splitDepositCents', () => {
  it('splits cents keeping the sum exact', () => {
    expect(splitDepositCents(100000, 0.6)).toEqual({ safeAddedCents: 60000, ambitionAddedCents: 40000 });
    expect(splitDepositCents(99999, 0.333)).toEqual({ safeAddedCents: 33299, ambitionAddedCents: 66700 });
    const { safeAddedCents, ambitionAddedCents } = splitDepositCents(99999, 0.333);
    expect(safeAddedCents + ambitionAddedCents).toBe(99999);
  });
});
