import type { MarketDataInput, StrategyParameterSet, StabilityReport } from './types';
import { extractReturnsForSymbols, scoreParameterSet } from './walk-forward';

function deepCloneParams(p: StrategyParameterSet): StrategyParameterSet {
  return {
    ...p,
    safeAllocation: { ...p.safeAllocation },
    ambitionAllocation: { ...p.ambitionAllocation },
  };
}

function perturbWeights(
  weights: { [symbol: string]: number },
  symbol: string,
  delta: number,
): { [symbol: string]: number } {
  const result = { ...weights };
  const current = result[symbol] ?? 0;
  const adjusted = Math.max(0, Math.min(1, current + delta));
  result[symbol] = adjusted;

  const otherSymbols = Object.keys(result).filter(k => k !== symbol);
  const otherTotal = otherSymbols.reduce((s, k) => s + (result[k] ?? 0), 0);
  const diff = adjusted - current;

  if (otherTotal > 0 && otherSymbols.length > 0) {
    for (const k of otherSymbols) {
      result[k] = (result[k] ?? 0) - diff * ((result[k] ?? 0) / otherTotal);
    }
  }

  const sum = Object.values(result).reduce((s, v) => s + v, 0);
  if (sum > 0) {
    for (const k of Object.keys(result)) {
      result[k] = (result[k] ?? 0) / sum;
    }
  }

  return result;
}

export function checkStability(
  data: MarketDataInput,
  symbols: string[],
  optimalParams: StrategyParameterSet,
  radius: number = 0.05,
  threshold: number = 0.1,
  riskFreeRate: number = 0,
  testRatio: number = 0.3,
): StabilityReport {
  const allReturns = extractReturnsForSymbols(data, symbols);
  if (allReturns.length === 0) {
    return { gradient: 1, threshold, isStable: false, neighborhoodSharpeRatios: [] };
  }

  const totalObs = allReturns[0].length;
  const testStart = Math.floor(totalObs * (1 - testRatio));
  const testEnd = totalObs - 1;

  const baseScore = scoreParameterSet(
    symbols, allReturns, testStart, testEnd, optimalParams, riskFreeRate,
  );

  const neighborhoodSharpeRatios: number[] = [baseScore];
  const gradients: number[] = [];

  const scalarParams: Array<{ key: keyof StrategyParameterSet; get: (p: StrategyParameterSet) => number; set: (p: StrategyParameterSet, v: number) => void; isInt?: boolean }> = [
    {
      key: 'triggerLine',
      get: (p) => p.triggerLine,
      set: (p, v) => { p.triggerLine = Math.round(v); },
      isInt: true,
    },
    {
      key: 'safeRatio',
      get: (p) => p.safeRatio,
      set: (p, v) => { p.safeRatio = Math.max(0, Math.min(1, v)); },
    },
    {
      key: 'ambitionRatio',
      get: (p) => p.ambitionRatio,
      set: (p, v) => { p.ambitionRatio = Math.max(0, Math.min(1, v)); },
    },
    {
      key: 'bsmThreshold',
      get: (p) => p.bsmThreshold,
      set: (p, v) => { p.bsmThreshold = Math.max(0, v); },
    },
    {
      key: 'maShortWindow',
      get: (p) => p.maShortWindow,
      set: (p, v) => { p.maShortWindow = Math.max(1, Math.round(v)); },
      isInt: true,
    },
    {
      key: 'maLongWindow',
      get: (p) => p.maLongWindow,
      set: (p, v) => { p.maLongWindow = Math.max(1, Math.round(v)); },
      isInt: true,
    },
  ];

  for (const param of scalarParams) {
    const baseVal = param.get(optimalParams);
    if (baseVal === 0) continue;

    const perturbAmount = Math.max(param.isInt ? 1 : radius, Math.abs(baseVal * radius));
    if (perturbAmount === 0) continue;

    const pUp = deepCloneParams(optimalParams);
    param.set(pUp, baseVal + perturbAmount);
    const scoreUp = scoreParameterSet(
      symbols, allReturns, testStart, testEnd, pUp, riskFreeRate,
    );
    neighborhoodSharpeRatios.push(scoreUp);
    gradients.push(Math.abs(scoreUp - baseScore) / perturbAmount);

    const pDown = deepCloneParams(optimalParams);
    param.set(pDown, Math.max(0, baseVal - perturbAmount));
    const scoreDown = scoreParameterSet(
      symbols, allReturns, testStart, testEnd, pDown, riskFreeRate,
    );
    neighborhoodSharpeRatios.push(scoreDown);
    gradients.push(Math.abs(scoreDown - baseScore) / perturbAmount);
  }

  const safeSymbols = Object.keys(optimalParams.safeAllocation);
  for (const sym of safeSymbols) {
    const baseW = optimalParams.safeAllocation[sym] ?? 0;
    const delta = Math.max(radius, baseW > 0 ? baseW * radius : radius);

    const pUp = deepCloneParams(optimalParams);
    pUp.safeAllocation = perturbWeights(pUp.safeAllocation, sym, delta);
    const scoreUp = scoreParameterSet(
      symbols, allReturns, testStart, testEnd, pUp, riskFreeRate,
    );
    neighborhoodSharpeRatios.push(scoreUp);
    gradients.push(Math.abs(scoreUp - baseScore) / delta);

    const pDown = deepCloneParams(optimalParams);
    pDown.safeAllocation = perturbWeights(pDown.safeAllocation, sym, -delta);
    const scoreDown = scoreParameterSet(
      symbols, allReturns, testStart, testEnd, pDown, riskFreeRate,
    );
    neighborhoodSharpeRatios.push(scoreDown);
    gradients.push(Math.abs(scoreDown - baseScore) / delta);
  }

  const ambitionSymbols = Object.keys(optimalParams.ambitionAllocation);
  for (const sym of ambitionSymbols) {
    const baseW = optimalParams.ambitionAllocation[sym] ?? 0;
    const delta = Math.max(radius, baseW > 0 ? baseW * radius : radius);

    const pUp = deepCloneParams(optimalParams);
    pUp.ambitionAllocation = perturbWeights(pUp.ambitionAllocation, sym, delta);
    const scoreUp = scoreParameterSet(
      symbols, allReturns, testStart, testEnd, pUp, riskFreeRate,
    );
    neighborhoodSharpeRatios.push(scoreUp);
    gradients.push(Math.abs(scoreUp - baseScore) / delta);

    const pDown = deepCloneParams(optimalParams);
    pDown.ambitionAllocation = perturbWeights(pDown.ambitionAllocation, sym, -delta);
    const scoreDown = scoreParameterSet(
      symbols, allReturns, testStart, testEnd, pDown, riskFreeRate,
    );
    neighborhoodSharpeRatios.push(scoreDown);
    gradients.push(Math.abs(scoreDown - baseScore) / delta);
  }

  const avgGradient = gradients.length > 0
    ? gradients.reduce((s, g) => s + g, 0) / gradients.length
    : 0;

  return {
    gradient: avgGradient,
    threshold,
    isStable: avgGradient < threshold,
    neighborhoodSharpeRatios,
  };
}
