import type { CpcvFold, CpcvResult, MarketDataInput } from './types';
import { computeSharpeRatio, computeSkewness, computeKurtosis, computeDSR } from './dsr';

function combinations(n: number, k: number): number[][] {
  const result: number[][] = [];

  function backtrack(start: number, current: number[]) {
    if (current.length === k) {
      result.push([...current]);
      return;
    }
    for (let i = start; i < n; i++) {
      current.push(i);
      backtrack(i + 1, current);
      current.pop();
    }
  }

  backtrack(0, []);
  return result;
}

function sampleCombinations(n: number, k: number, maxSamples: number): number[][] {
  const all = combinations(n, k);
  if (all.length <= maxSamples) return all;

  const sampled: number[][] = [];
  const indices = new Set<number>();

  while (sampled.length < maxSamples) {
    const idx = Math.floor(Math.random() * all.length);
    if (!indices.has(idx)) {
      indices.add(idx);
      sampled.push(all[idx]);
    }
  }

  return sampled;
}

export function generateCpcvFolds(
  totalObs: number,
  numGroups: number = 10,
  numTestGroups: number = 2,
  numSplits: number = 10,
  purgeDays: number = 5,
  embargoDays: number = 5,
): CpcvFold[] {
  const groupSize = Math.floor(totalObs / numGroups);
  if (groupSize < 1) {
    throw new Error(`totalObs (${totalObs}) too small for ${numGroups} groups`);
  }

  const combs = sampleCombinations(numGroups, numTestGroups, numSplits);

  return combs.map((testGroupIndices) => {
    const testGroupSet = new Set(testGroupIndices);
    const trainGroupIndices: number[] = [];

    for (let i = 0; i < numGroups; i++) {
      if (!testGroupSet.has(i)) {
        trainGroupIndices.push(i);
      }
    }

    const trainEnd = (Math.max(...trainGroupIndices) + 1) * groupSize - 1;
    const testStart = Math.min(...testGroupIndices) * groupSize;
    const testEnd = (Math.max(...testGroupIndices) + 1) * groupSize - 1;

    const purgedTrainEnd = Math.min(trainEnd, testStart - purgeDays - 1);
    const embargoedTestStart = Math.max(testStart, trainEnd + embargoDays + 1);

    return {
      trainStart: 0,
      trainEnd: Math.max(0, purgedTrainEnd),
      testStart: Math.min(totalObs - 1, embargoedTestStart),
      testEnd: Math.min(totalObs - 1, testEnd),
    };
  }).filter((f) => f.trainEnd > f.trainStart && f.testEnd - f.testStart >= 5);
}

export function computeReturnsFromPrices(prices: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push(prices[i] / prices[i - 1] - 1);
  }
  return returns;
}

export function extractPrices(
  data: MarketDataInput,
  symbols: string[],
  weights: { [symbol: string]: number },
): number[] {
  const firstSymbol = symbols[0];
  if (!firstSymbol || !data[firstSymbol]) return [];

  const n = data[firstSymbol].close.length;
  const weightedPrices: number[] = new Array(n).fill(0);

  for (const sym of symbols) {
    const df = data[sym];
    if (!df) continue;
    const w = weights[sym] ?? 0;
    for (let i = 0; i < n; i++) {
      weightedPrices[i] += df.close[i] * w;
    }
  }

  return weightedPrices;
}

export function computePortfolioReturns(
  data: MarketDataInput,
  symbols: string[],
  weights: { [symbol: string]: number },
): number[] {
  const prices = extractPrices(data, symbols, weights);
  return computeReturnsFromPrices(prices);
}

export function applyFoldToReturns(
  returns: number[],
  fold: CpcvFold,
): { trainReturns: number[]; testReturns: number[] } {
  return {
    trainReturns: returns.slice(fold.trainStart, fold.trainEnd + 1),
    testReturns: returns.slice(fold.testStart, fold.testEnd + 1),
  };
}

export function computeCpcvResult(
  data: MarketDataInput,
  symbols: string[],
  weights: { [symbol: string]: number },
  folds: CpcvFold[],
  riskFreeRate: number = 0,
  alpha: number = 0.05,
): CpcvResult {
  const allReturns = computePortfolioReturns(data, symbols, weights);
  const n = allReturns.length;

  const foldSharpeRatios: number[] = [];

  for (const fold of folds) {
    const { testReturns } = applyFoldToReturns(allReturns, fold);

    if (testReturns.length < 2) continue;

    const testSharpe = computeSharpeRatio(testReturns, riskFreeRate);
    foldSharpeRatios.push(testSharpe);
  }

  if (foldSharpeRatios.length === 0) {
    return {
      folds,
      foldSharpeRatios: [],
      sharpeDistribution: {
        mean: 0,
        std: 0,
        skewness: 0,
        percentiles: { p5: 0, p25: 0, p50: 0, p75: 0, p95: 0 },
      },
      dsr: 0,
    };
  }

  const mean =
    foldSharpeRatios.reduce((s, v) => s + v, 0) / foldSharpeRatios.length;
  const std = Math.sqrt(
    foldSharpeRatios.reduce((s, v) => s + (v - mean) ** 2, 0) / (foldSharpeRatios.length - 1),
  );
  const distSkewness = computeSkewness(foldSharpeRatios);

  const sorted = [...foldSharpeRatios].sort((a, b) => a - b);
  const p5 = sorted[Math.floor(sorted.length * 0.05)];
  const p25 = sorted[Math.floor(sorted.length * 0.25)];
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p75 = sorted[Math.floor(sorted.length * 0.75)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];

  const returnsSkewness = computeSkewness(allReturns);
  const returnsKurtosis = computeKurtosis(allReturns);
  const dsr = computeDSR(mean, n, returnsSkewness, alpha, returnsKurtosis);

  return {
    folds,
    foldSharpeRatios,
    sharpeDistribution: {
        mean,
        std,
        skewness: distSkewness,
        percentiles: { p5, p25, p50, p75, p95 },
      },
    dsr,
  };
}
