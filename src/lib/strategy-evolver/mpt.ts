import type { MarketDataInput, PortfolioWeights, FrontierPoint, EfficientFrontier, EvolverConfig, CpcvFold } from './types';
import { computeReturnsFromPrices, computeCpcvResult } from './cpcv';
import { annualizeReturn, annualizeVolatility } from './dsr';

const DEFAULT_RISK_FREE_RATE = 0.025;

function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function matVecMul(mat: number[][], vec: number[]): number[] {
  return mat.map(row => dot(row, vec));
}

function alignDataFrames(data: MarketDataInput, symbols: string[]): { aligned: MarketDataInput; count: number } {
  let minLen = Infinity;
  for (const sym of symbols) {
    const df = data[sym];
    if (!df) continue;
    if (df.close.length < minLen) minLen = df.close.length;
  }

  if (minLen === Infinity || minLen < 10) {
    throw new Error('No valid data or too few observations');
  }

  const aligned: MarketDataInput = {};
  for (const sym of symbols) {
    const df = data[sym];
    if (!df) continue;
    aligned[sym] = {
      dates: df.dates.slice(-minLen),
      close: df.close.slice(-minLen),
      open: df.open.slice(-minLen),
      high: df.high.slice(-minLen),
      low: df.low.slice(-minLen),
      volume: df.volume.slice(-minLen),
    };
  }

  return { aligned, count: minLen };
}

export function computeMeanReturns(data: MarketDataInput, symbols: string[]): number[] {
  const { aligned } = alignDataFrames(data, symbols);

  return symbols.map((sym) => {
    const df = aligned[sym];
    if (!df) return 0;
    const returns = computeReturnsFromPrices(df.close);
    if (returns.length < 2) return 0;
    const dailyMean = returns.reduce((s, r) => s + r, 0) / returns.length;
    return dailyMean;
  });
}

export function computeCovarianceMatrix(data: MarketDataInput, symbols: string[]): number[][] {
  const { aligned } = alignDataFrames(data, symbols);

  const returnsMatrix: number[][] = symbols.map((sym) => {
    const df = aligned[sym];
    if (!df) return [];
    return computeReturnsFromPrices(df.close);
  });

  const n = returnsMatrix[0]?.length ?? 0;
  if (n < 2) {
    return symbols.map(() => symbols.map(() => 0));
  }

  const means = returnsMatrix.map(r => r.reduce((s, v) => s + v, 0) / n);

  const cov: number[][] = [];
  for (let i = 0; i < symbols.length; i++) {
    cov[i] = [];
    for (let j = 0; j < symbols.length; j++) {
      let sum = 0;
      for (let t = 0; t < n; t++) {
        sum += (returnsMatrix[i][t] - means[i]) * (returnsMatrix[j][t] - means[j]);
      }
      cov[i][j] = sum / (n - 1);
    }
  }

  return cov;
}

export function generateRandomPortfolios(numAssets: number, count: number): number[][] {
  const portfolios: number[][] = [];

  for (let p = 0; p < count; p++) {
    const raw: number[] = [];
    let total = 0;

    for (let i = 0; i < numAssets; i++) {
      const v = -Math.log(Math.random() + 1e-10);
      raw.push(v);
      total += v;
    }

    const normalized = raw.map(v => v / total);
    portfolios.push(normalized);
  }

  return portfolios;
}

export function evaluatePortfolio(
  weights: number[],
  symbols: string[],
  meanReturns: number[],
  covMatrix: number[][],
  riskFreeRate: number = DEFAULT_RISK_FREE_RATE,
): { expectedReturn: number; volatility: number; sharpeRatio: number } {
  const expectedReturn = dot(weights, meanReturns);
  const portfolioVariance = dot(weights, matVecMul(covMatrix, weights));
  const volatility = Math.sqrt(Math.max(0, portfolioVariance));

  const excessReturn = expectedReturn - riskFreeRate / 252;
  const sharpeRatio = volatility > 0 ? excessReturn / volatility : 0;

  return { expectedReturn, volatility, sharpeRatio };
}

function weightsToRecord(weights: number[], symbols: string[]): PortfolioWeights {
  const record: PortfolioWeights = {};
  for (let i = 0; i < symbols.length; i++) {
    record[symbols[i]] = weights[i];
  }
  return record;
}

interface PortfolioCandidate {
  weights: number[];
  expectedReturn: number;
  volatility: number;
  sharpeRatio: number;
}

export function extractEfficientFrontier(
  candidates: PortfolioCandidate[],
  numPoints: number = 50,
): PortfolioCandidate[] {
  if (candidates.length === 0) return [];

  const sorted = [...candidates].sort((a, b) => a.volatility - b.volatility);
  const frontier: PortfolioCandidate[] = [];

  let maxReturnSoFar = -Infinity;
  for (const p of sorted) {
    if (p.expectedReturn > maxReturnSoFar) {
      frontier.push(p);
      maxReturnSoFar = p.expectedReturn;
    }
  }

  if (frontier.length <= 2) return frontier;

  const minVol = frontier[0].volatility;
  const maxVol = frontier[frontier.length - 1].volatility;
  const step = (maxVol - minVol) / (numPoints - 1);

  if (step === 0) return [frontier[0]];

  const sampled: PortfolioCandidate[] = [];
  for (let i = 0; i < numPoints; i++) {
    const targetVol = minVol + step * i;
    let closest = frontier[0];
    let minDist = Math.abs(frontier[0].volatility - targetVol);

    for (let j = 1; j < frontier.length; j++) {
      const dist = Math.abs(frontier[j].volatility - targetVol);
      if (dist < minDist) {
        minDist = dist;
        closest = frontier[j];
      }
    }

    if (sampled.length === 0 || closest.volatility !== sampled[sampled.length - 1].volatility) {
      sampled.push(closest);
    }
  }

  return sampled;
}

export function computeEfficientFrontier(
  data: MarketDataInput,
  symbols: string[],
  config?: Partial<Pick<EvolverConfig, 'frontierPoints'>>,
  riskFreeRate: number = DEFAULT_RISK_FREE_RATE,
): Omit<EfficientFrontier, 'points'> & { points: FrontierPoint[] } {
  const numPoints = config?.frontierPoints ?? 50;
  const numCandidates = Math.max(numPoints * 20, 1000);

  const meanReturns = computeMeanReturns(data, symbols);
  const covMatrix = computeCovarianceMatrix(data, symbols);

  const rawPortfolios = generateRandomPortfolios(symbols.length, numCandidates);
  const candidates: PortfolioCandidate[] = rawPortfolios.map((weights) => {
    const stats = evaluatePortfolio(weights, symbols, meanReturns, covMatrix, riskFreeRate);
    return { weights, ...stats };
  });

  const frontierCandidates = extractEfficientFrontier(candidates, numPoints);

  const frontierPoints: FrontierPoint[] = frontierCandidates.map((c) => ({
    weights: weightsToRecord(c.weights, symbols),
    expectedReturn: annualizeReturn(c.expectedReturn, 252),
    volatility: annualizeVolatility(c.volatility, 252),
    sharpeRatio: c.sharpeRatio * Math.sqrt(252),
  }));

  let maxSharpePortfolio = frontierPoints[0];
  let minVolPortfolio = frontierPoints[0];

  for (const p of frontierPoints) {
    if (p.sharpeRatio > maxSharpePortfolio.sharpeRatio) maxSharpePortfolio = p;
    if (p.volatility < minVolPortfolio.volatility) minVolPortfolio = p;
  }

  return { points: frontierPoints, maxSharpePortfolio, minVolPortfolio };
}

export function computeEfficientFrontierWithCpcv(
  data: MarketDataInput,
  symbols: string[],
  folds: CpcvFold[],
  config?: Partial<Pick<EvolverConfig, 'frontierPoints'>>,
  riskFreeRate: number = DEFAULT_RISK_FREE_RATE,
  alpha: number = 0.05,
): EfficientFrontier {
  const { points } = computeEfficientFrontier(
    data, symbols, config, riskFreeRate,
  );

  const pointsWithCpcv = points.map((point) => {
    const cpcvResult = computeCpcvResult(
      data, symbols, point.weights, folds, riskFreeRate, alpha,
    );
    return { ...point, sharpeRatio: cpcvResult.dsr, cpcvResult };
  });

  let updatedMaxSharpe = pointsWithCpcv[0];
  let updatedMinVol = pointsWithCpcv[0];

  for (const p of pointsWithCpcv) {
    if (p.sharpeRatio > updatedMaxSharpe.sharpeRatio) updatedMaxSharpe = p;
    if (p.volatility < updatedMinVol.volatility) updatedMinVol = p;
  }

  return { points: pointsWithCpcv, maxSharpePortfolio: updatedMaxSharpe, minVolPortfolio: updatedMinVol };
}
