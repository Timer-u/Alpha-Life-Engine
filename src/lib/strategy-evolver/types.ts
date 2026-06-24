import type { LayerType, SignalType } from '../../types/api';

export interface OHLCV {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface DataFrame {
  dates: string[];
  close: number[];
  open: number[];
  high: number[];
  low: number[];
  volume: number[];
}

export interface MarketDataInput {
  [symbol: string]: DataFrame;
}

export interface CpcvFold {
  trainStart: number;
  trainEnd: number;
  testStart: number;
  testEnd: number;
}

export interface CpcvResult {
  folds: CpcvFold[];
  foldSharpeRatios: number[];
  sharpeDistribution: {
    mean: number;
    std: number;
    skewness: number;
    percentiles: { p5: number; p25: number; p50: number; p75: number; p95: number };
  };
  dsr: number;
}

export interface PortfolioWeights {
  [symbol: string]: number;
}

export interface FrontierPoint {
  weights: PortfolioWeights;
  expectedReturn: number;
  volatility: number;
  sharpeRatio: number;
  cpcvResult?: CpcvResult;
}

export interface EfficientFrontier {
  points: FrontierPoint[];
  maxSharpePortfolio: FrontierPoint;
  minVolPortfolio: FrontierPoint;
}

export interface StrategyParameterSet {
  triggerLine: number;
  safeRatio: number;
  ambitionRatio: number;
  bsmThreshold: number;
  maShortWindow: number;
  maLongWindow: number;
  safeAllocation: PortfolioWeights;
  ambitionAllocation: PortfolioWeights;
}

export interface StrategyParameterBounds {
  triggerLine: [number, number];
  safeRatio: [number, number];
  ambitionRatio: [number, number];
  bsmThreshold: [number, number];
  maShortWindow: [number, number];
  maLongWindow: [number, number];
  safeAllocation: { [symbol: string]: [number, number] };
  ambitionAllocation: { [symbol: string]: [number, number] };
}

export interface WalkForwardWindow {
  trainStart: number;
  trainEnd: number;
  testStart: number;
  testEnd: number;
}

export interface WalkForwardResult {
  window: WalkForwardWindow;
  optimalParams: StrategyParameterSet;
  trainSharpe: number;
  testSharpe: number;
  dsr: number;
  rank: number;
}

export interface WalkForwardSummary {
  results: WalkForwardResult[];
  dsrRankings: number[];
  pboScore: number;
  stabilityScore: number;
}

export interface GbmPath {
  dates: string[];
  prices: number[][];
  returns: number[][];
}

export interface MonteCarloResult {
  paths: GbmPath;
  summary: {
    meanReturn: number;
    medianReturn: number;
    stdReturn: number;
    var95: number;
    var99: number;
    maxDrawdown: number;
    percentiles: {
      p1: number;
      p5: number;
      p10: number;
      p25: number;
      p50: number;
      p75: number;
      p90: number;
      p95: number;
      p99: number;
    };
  };
}

export interface StabilityReport {
  gradient: number;
  threshold: number;
  isStable: boolean;
  neighborhoodSharpeRatios: number[];
}

export interface PboResult {
  score: number;
  threshold: number;
  isRejected: boolean;
  rankingMatrix: number[][];
}

export interface EvolverConfig {
  cpcvSplits: number;
  cpcvTestSize: number;
  purgeDays: number;
  embargoDays: number;
  frontierPoints: number;
  gbmPaths: number;
  gbmDays: number;
  walkForwardWindows: number;
  walkForwardTrainRatio: number;
  stabilityNeighborhoodRadius: number;
  stabilityGradientThreshold: number;
  pboRejectionThreshold: number;
  dsrAlpha: number;
  parameterBounds: StrategyParameterBounds;
}

export const DEFAULT_EVOLVER_CONFIG: EvolverConfig = {
  cpcvSplits: 10,
  cpcvTestSize: 0.2,
  purgeDays: 5,
  embargoDays: 5,
  frontierPoints: 50,
  gbmPaths: 10000,
  gbmDays: 252,
  walkForwardWindows: 6,
  walkForwardTrainRatio: 0.7,
  stabilityNeighborhoodRadius: 0.05,
  stabilityGradientThreshold: 0.1,
  pboRejectionThreshold: 0.5,
  dsrAlpha: 0.05,
  parameterBounds: {
    triggerLine: [1000, 3000],
    safeRatio: [0.3, 0.8],
    ambitionRatio: [0.2, 0.7],
    bsmThreshold: [1.0, 2.0],
    maShortWindow: [5, 50],
    maLongWindow: [20, 200],
    safeAllocation: {
      '511360': [0, 1],
      '511880': [0, 1],
    },
    ambitionAllocation: {
      '000300': [0, 1],
      '000905': [0, 1],
      '000922': [0, 1],
    },
  },
};

export interface StrategyReportData {
  timestamp: string;
  config: EvolverConfig;
  efficientFrontier: EfficientFrontier;
  monteCarloResult: MonteCarloResult;
  walkForwardSummary: WalkForwardSummary;
  stabilityReport: StabilityReport;
  pboResult: PboResult;
  recommendedParams: StrategyParameterSet;
}

export { LayerType, SignalType };
