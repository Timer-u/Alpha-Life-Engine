import type {
  MarketDataInput,
  StrategyParameterSet,
  StrategyParameterBounds,
  WalkForwardWindow,
  WalkForwardResult,
  WalkForwardSummary,
} from './types';
import { computeReturnsFromPrices } from './cpcv';
import { computeSharpeRatio, computeDSR, computeSkewness, computeKurtosis } from './dsr';

export function generateWalkForwardWindows(
  totalObs: number,
  numWindows: number = 6,
  trainRatio: number = 0.7,
): WalkForwardWindow[] {
  if (totalObs < numWindows * 20) {
    throw new Error(`totalObs (${totalObs}) too small for ${numWindows} windows`);
  }

  const windowsPerFold = Math.floor(totalObs / numWindows);
  const trainSize = Math.floor(windowsPerFold * trainRatio);
  const testSize = windowsPerFold - trainSize;

  const windows: WalkForwardWindow[] = [];

  for (let w = 0; w < numWindows; w++) {
    const windowStart = w * windowsPerFold;

    if (windowStart + testSize > totalObs) break;

    windows.push({
      trainStart: windowStart,
      trainEnd: windowStart + trainSize - 1,
      testStart: windowStart + trainSize,
      testEnd: windowStart + windowsPerFold - 1,
    });
  }

  return windows;
}

function randomInRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randomIntInRange(min: number, max: number): number {
  return Math.floor(randomInRange(min, max + 1));
}

function randomWeights(bounds: { [symbol: string]: [number, number] }): { [symbol: string]: number } {
  const symbols = Object.keys(bounds);
  const raw: { [key: string]: number } = {};

  let total = 0;
  for (const sym of symbols) {
    const [lo, hi] = bounds[sym];
    const b = lo + Math.random() * (hi - lo);
    raw[sym] = b;
    total += b;
  }

  if (total > 0) {
    for (const sym of symbols) {
      raw[sym] /= total;
    }
  }

  return raw;
}

export function generateRandomParameterSets(
  bounds: StrategyParameterBounds,
  count: number,
): StrategyParameterSet[] {
  const sets: StrategyParameterSet[] = [];

  for (let i = 0; i < count; i++) {
    const safeRatio = randomInRange(bounds.safeRatio[0], bounds.safeRatio[1]);
    const ambitionRatio = randomInRange(bounds.ambitionRatio[0], bounds.ambitionRatio[1]);
    const totalRatio = safeRatio + ambitionRatio;
    const safeRatioNorm = totalRatio > 0 ? safeRatio / totalRatio : 0.5;
    const ambitionRatioNorm = totalRatio > 0 ? ambitionRatio / totalRatio : 0.5;

    const maShortWindow = randomIntInRange(bounds.maShortWindow[0], bounds.maShortWindow[1]);
    const maLongWindowLo = Math.max(maShortWindow + 1, bounds.maLongWindow[0]);
    const maLongWindowHi = Math.max(maLongWindowLo, bounds.maLongWindow[1]);
    const maLongWindow = randomIntInRange(maLongWindowLo, maLongWindowHi);

    sets.push({
      triggerLine: randomIntInRange(bounds.triggerLine[0], bounds.triggerLine[1]),
      safeRatio: safeRatioNorm,
      ambitionRatio: ambitionRatioNorm,
      bsmThreshold: randomInRange(bounds.bsmThreshold[0], bounds.bsmThreshold[1]),
      maShortWindow,
      maLongWindow,
      safeAllocation: randomWeights(bounds.safeAllocation),
      ambitionAllocation: randomWeights(bounds.ambitionAllocation),
    });
  }

  return sets;
}

export function extractReturnsForSymbols(
  data: MarketDataInput,
  symbols: string[],
): number[][] {
  const firstSymbol = symbols[0];
  if (!firstSymbol || !data[firstSymbol]) return [];

  const n = data[firstSymbol].close.length;
  const result: number[][] = [];

  for (const sym of symbols) {
    const df = data[sym];
    if (!df) {
      result.push(new Array(n - 1).fill(0));
      continue;
    }
    result.push(computeReturnsFromPrices(df.close));
  }

  return result;
}

export function computePortfolioReturnsForParams(
  symbols: string[],
  allReturns: number[][],
  start: number,
  end: number,
  params: StrategyParameterSet,
): number[] {
  const safeSymbols = ['511360', '511880'];
  const ambitionSymbols = ['000300', '000905', '000922'];

  const safeIndices = safeSymbols.map(s => symbols.indexOf(s)).filter(i => i >= 0);
  const ambitionIndices = ambitionSymbols.map(s => symbols.indexOf(s)).filter(i => i >= 0);

  const length = end - start + 1;
  if (length < 5) return [];

  const combinedReturns: number[] = new Array(length).fill(0);

  for (let t = 0; t < length; t++) {
    const globalT = start + t;

    let safeReturn = 0;
    let safeWeightSum = 0;
    for (const idx of safeIndices) {
      const w = params.safeAllocation[symbols[idx]] ?? 0;
      safeReturn += w * allReturns[idx][globalT];
      safeWeightSum += w;
    }
    if (safeWeightSum > 0) safeReturn /= safeWeightSum;

    let ambitionReturn = 0;
    let ambitionWeightSum = 0;
    for (const idx of ambitionIndices) {
      const w = params.ambitionAllocation[symbols[idx]] ?? 0;
      ambitionReturn += w * allReturns[idx][globalT];
      ambitionWeightSum += w;
    }
    if (ambitionWeightSum > 0) ambitionReturn /= ambitionWeightSum;

    combinedReturns[t] = params.safeRatio * safeReturn + params.ambitionRatio * ambitionReturn;
  }

  return combinedReturns;
}

export function scoreParameterSet(
  symbols: string[],
  allReturns: number[][],
  start: number,
  end: number,
  params: StrategyParameterSet,
  riskFreeRate: number = 0,
): number {
  const returns = computePortfolioReturnsForParams(symbols, allReturns, start, end, params);
  if (returns.length < 5) return -1;
  return computeSharpeRatio(returns, riskFreeRate);
}

function computePBO(
  trainRanks: number[][],
  testRanks: number[][],
): { score: number; rankingMatrix: number[][] } {
  const numParams = trainRanks.length;
  const numSplits = trainRanks[0]?.length ?? 0;

  let underperformCount = 0;
  let totalCount = 0;

  const rankingMatrix: number[][] = [];

  for (let s = 0; s < numSplits; s++) {
    const row: number[] = [];

    let bestTrainIdx = 0;
    let bestTrainRank = Infinity;
    for (let i = 0; i < numParams; i++) {
      if (trainRanks[i][s] < bestTrainRank) {
        bestTrainRank = trainRanks[i][s];
        bestTrainIdx = i;
      }
    }

    const testRankOfBest = testRanks[bestTrainIdx][s];
    const medianRank = numParams / 2;

    row.push(bestTrainIdx);
    row.push(testRankOfBest);
    rankingMatrix.push(row);

    if (testRankOfBest > medianRank) {
      underperformCount++;
    }
    totalCount++;
  }

  return {
    score: totalCount > 0 ? underperformCount / totalCount : 0,
    rankingMatrix,
  };
}

export function runWalkForward(
  data: MarketDataInput,
  symbols: string[],
  bounds: StrategyParameterBounds,
  numParameterSets: number = 200,
  numWindows: number = 6,
  trainRatio: number = 0.7,
  riskFreeRate: number = 0,
  alpha: number = 0.05,
): WalkForwardSummary {
  const allReturns = extractReturnsForSymbols(data, symbols);
  if (allReturns.length === 0) {
    return { results: [], dsrRankings: [], pboScore: 1, stabilityScore: 0 };
  }

  const totalObs = allReturns[0].length;
  const windows = generateWalkForwardWindows(totalObs, numWindows, trainRatio);
  const paramSets = generateRandomParameterSets(bounds, numParameterSets);

  const results: WalkForwardResult[] = [];
  const trainRankMatrix: number[][] = paramSets.map(() => []);
  const testRankMatrix: number[][] = paramSets.map(() => []);

  for (const window of windows) {
    const trainScores: number[] = [];
    const testScores: number[] = [];

    for (let p = 0; p < paramSets.length; p++) {
      const trainScore = scoreParameterSet(
        symbols, allReturns,
        window.trainStart, window.trainEnd,
        paramSets[p], riskFreeRate,
      );
      const testScore = scoreParameterSet(
        symbols, allReturns,
        window.testStart, window.testEnd,
        paramSets[p], riskFreeRate,
      );

      trainScores.push(trainScore);
      testScores.push(testScore);
    }

    const trainSortedIndices = trainScores
      .map((s, i) => ({ score: s, idx: i }))
      .sort((a, b) => b.score - a.score)
      .map((x) => x.idx);

    const testSortedIndices = testScores
      .map((s, i) => ({ score: s, idx: i }))
      .sort((a, b) => b.score - a.score)
      .map((x) => x.idx);

    for (let rank = 0; rank < paramSets.length; rank++) {
      trainRankMatrix[trainSortedIndices[rank]].push(rank + 1);
      testRankMatrix[testSortedIndices[rank]].push(rank + 1);
    }

    const bestParamIdx = trainSortedIndices[0];
    const bestParams = paramSets[bestParamIdx];
    const bestTrainScore = trainScores[bestParamIdx];
    const bestTestScore = testScores[bestParamIdx];

    const bestReturns = computePortfolioReturnsForParams(
      symbols, allReturns,
      window.testStart, window.testEnd,
      bestParams,
    );
    const n = bestReturns.length;
    const returnsSkewness = n >= 3 ? computeSkewness(bestReturns) : 0;
    const returnsKurtosis = n >= 4 ? computeKurtosis(bestReturns) : 0;
    const dsr = computeDSR(bestTestScore, n, returnsSkewness, alpha, returnsKurtosis);

    results.push({
      window,
      optimalParams: bestParams,
      trainSharpe: bestTrainScore,
      testSharpe: bestTestScore,
      dsr,
      rank: 1,
    });
  }

  const dsrRankings = results
    .map((r) => r.dsr)
    .sort((a, b) => b - a);

  const pboResult = computePBO(trainRankMatrix, testRankMatrix);

  const testSharpeValues2 = results.map(r => r.testSharpe);
  const stabilityScore = testSharpeValues2.length > 1
    ? Math.abs(computeSharpeRatio(testSharpeValues2))
    : 0;

  return {
    results,
    dsrRankings,
    pboScore: pboResult.score,
    stabilityScore,
  };
}
