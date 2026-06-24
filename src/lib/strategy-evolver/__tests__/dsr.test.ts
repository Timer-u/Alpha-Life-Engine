import { describe, it, expect } from 'vitest';
import {
  normalCDF,
  normalInvCDF,
  computeSharpeRatio,
  computeSkewness,
  computeKurtosis,
  computeDSR,
  computeAnnualizedSharpe,
} from '../dsr';

describe('normalCDF', () => {
  it('returns 0.5 for x=0', () => {
    expect(normalCDF(0)).toBeCloseTo(0.5, 5);
  });

  it('returns ~0.8413 for x=1', () => {
    expect(normalCDF(1)).toBeCloseTo(0.841344, 4);
  });

  it('returns ~0.1587 for x=-1', () => {
    expect(normalCDF(-1)).toBeCloseTo(0.158655, 4);
  });

  it('returns ~0.9772 for x=2', () => {
    expect(normalCDF(2)).toBeCloseTo(0.97725, 4);
  });

  it('approaches 1 for large x', () => {
    expect(normalCDF(6)).toBeGreaterThan(0.999999);
  });

  it('approaches 0 for large negative x', () => {
    expect(normalCDF(-6)).toBeLessThan(1e-9);
  });
});

describe('normalInvCDF', () => {
  it('returns 0 for p=0.5', () => {
    expect(normalInvCDF(0.5)).toBeCloseTo(0, 4);
  });

  it('returns ~1.6449 for p=0.95', () => {
    expect(normalInvCDF(0.95)).toBeCloseTo(1.64485, 3);
  });

  it('returns ~-1.6449 for p=0.05', () => {
    expect(normalInvCDF(0.05)).toBeCloseTo(-1.64485, 3);
  });

  it('inverts normalCDF', () => {
    for (const p of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      expect(normalCDF(normalInvCDF(p))).toBeCloseTo(p, 4);
    }
  });
});

describe('computeSharpeRatio', () => {
  it('returns 0 for constant returns', () => {
    expect(computeSharpeRatio([0.01, 0.01, 0.01])).toBe(0);
  });

  it('returns positive Sharpe for positive excess returns', () => {
    const sr = computeSharpeRatio([0.001, 0.002, 0.0015, 0.003, -0.001], 0);
    expect(sr).toBeGreaterThan(0);
  });

  it('returns negative Sharpe for negative returns', () => {
    const sr = computeSharpeRatio([-0.01, -0.02, -0.015], 0);
    expect(sr).toBeLessThan(0);
  });

  it('handles riskFreeRate correctly', () => {
    const withoutRfr = computeSharpeRatio([0.001, 0.002, 0.0015], 0);
    const withRfr = computeSharpeRatio([0.001, 0.002, 0.0015], 0.001);
    expect(withRfr).toBeLessThan(withoutRfr);
  });

  it('returns 0 for fewer than 2 observations', () => {
    expect(computeSharpeRatio([0.01], 0)).toBe(0);
    expect(computeSharpeRatio([], 0)).toBe(0);
  });
});

describe('computeSkewness', () => {
  it('returns 0 for symmetric data', () => {
    expect(computeSkewness([1, 2, 3, 4, 5])).toBeCloseTo(0, 1);
  });

  it('returns positive for right-skewed', () => {
    const skew = computeSkewness([1, 1, 1, 1, 10]);
    expect(skew).toBeGreaterThan(0);
  });

  it('returns negative for left-skewed', () => {
    const skew = computeSkewness([1, 1, 1, 1, -10]);
    expect(skew).toBeLessThan(0);
  });

  it('returns 0 for fewer than 3 observations', () => {
    expect(computeSkewness([1, 2])).toBe(0);
  });
});

describe('computeKurtosis', () => {
  it('returns ~0 for normal-like data (excess kurtosis)', () => {
    const kurt = computeKurtosis([-2, -1, 0, 1, 2]);
    expect(Math.abs(kurt)).toBeLessThan(2);
  });

  it('returns excess kurtosis of ~ -1.2 for uniform-like data', () => {
    const kurt = computeKurtosis([-2, -1, 0, 1, 2]);
    expect(kurt).toBeLessThan(0);
  });

  it('returns excess kurtosis of 0 for normally distributed data in large samples', () => {
    const n = 10000;
    const normal = Array.from({ length: n }, () => {
      const u1 = Math.random();
      const u2 = Math.random();
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    });
    const kurt = computeKurtosis(normal);
    expect(Math.abs(kurt)).toBeLessThan(0.5);
  });

  it('returns 0 for fewer than 4 observations', () => {
    expect(computeKurtosis([1, 2, 3])).toBe(0);
  });
});

describe('computeDSR', () => {
  it('returns 0 for n<2', () => {
    expect(computeDSR(1, 1, 0, 0.05)).toBe(0);
  });

  it('returns >0.5 for positive Sharpe with normality', () => {
    const dsr = computeDSR(0.5, 252, 0, 0.05, 0);
    expect(dsr).toBeGreaterThan(0.5);
  });

  it('returns <0.5 for negative Sharpe', () => {
    const dsr = computeDSR(-0.5, 252, 0, 0.05, 0);
    expect(dsr).toBeLessThan(0.5);
  });

  it('decreases with higher alpha threshold', () => {
    const dsrLow = computeDSR(0.3, 252, 0, 0.01, 0);
    const dsrHigh = computeDSR(0.3, 252, 0, 0.10, 0);
    expect(dsrLow).toBeLessThan(dsrHigh);
  });

  it('handles negative skewness (conservative)', () => {
    const dsrNormal = computeDSR(0.5, 252, 0, 0.05, 0);
    const dsrNegSkew = computeDSR(0.5, 252, -1, 0.05, 0);
    expect(dsrNegSkew).toBeLessThan(dsrNormal);
  });

  it('handles positive kurtosis (conservative)', () => {
    const dsrNormal = computeDSR(0.5, 252, 0, 0.05, 0);
    const dsrFatTail = computeDSR(0.5, 252, 0, 0.05, 2);
    expect(dsrFatTail).toBeLessThan(dsrNormal);
  });
});

describe('computeAnnualizedSharpe', () => {
  it('scales daily Sharpe by sqrt(252)', () => {
    const dailyReturns = Array(252).fill(0.001).map((v, i) => v + (i % 2 === 0 ? 0.0005 : -0.0005));
    const annualized = computeAnnualizedSharpe(dailyReturns, 0);
    expect(annualized).toBeGreaterThan(0);
  });
});
