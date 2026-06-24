import type {
  MarketDataInput,
  StrategyReportData,
  EvolverConfig,
  StrategyParameterSet,
  EfficientFrontier,
  MonteCarloResult,
  WalkForwardSummary,
  StabilityReport,
  PboResult,
} from './types';
import { DEFAULT_EVOLVER_CONFIG } from './types';
import { generateCpcvFolds } from './cpcv';
import { computeEfficientFrontierWithCpcv } from './mpt';
import { runMonteCarlo } from './monte-carlo';
import { runWalkForward } from './walk-forward';
import { checkStability } from './stability';

export function generateReport(
  data: MarketDataInput,
  symbols: string[],
  config: EvolverConfig = DEFAULT_EVOLVER_CONFIG,
  riskFreeRate: number = 0.025,
): StrategyReportData {
  const timestamp = new Date().toISOString();

  const firstSymbol = symbols[0];
  const totalObs = firstSymbol && data[firstSymbol] ? data[firstSymbol].close.length : 0;

  const numGroups = 10;
  const numTestGroups = Math.max(1, Math.round(numGroups * config.cpcvTestSize));
  const cpcvFolds = generateCpcvFolds(
    totalObs - 1,
    numGroups,
    numTestGroups,
    config.cpcvSplits,
    config.purgeDays,
    config.embargoDays,
  );

  const initialPrices = symbols.map(s => {
    const df = data[s];
    return df ? df.close[df.close.length - 1] : 1;
  });

  const efficientFrontier: EfficientFrontier = computeEfficientFrontierWithCpcv(
    data, symbols, cpcvFolds, config, riskFreeRate, config.dsrAlpha,
  );

  const maxSharpeWeights = efficientFrontier.maxSharpePortfolio.weights;

  const monteCarloResult: MonteCarloResult = runMonteCarlo(
    data, symbols, maxSharpeWeights, initialPrices,
    config.gbmDays, config.gbmPaths,
  );

  const walkForwardSummary: WalkForwardSummary = runWalkForward(
    data, symbols, config.parameterBounds, 200,
    config.walkForwardWindows, config.walkForwardTrainRatio,
    riskFreeRate / 252, config.dsrAlpha,
  );

  const pboResult: PboResult = {
    score: walkForwardSummary.pboScore,
    threshold: config.pboRejectionThreshold,
    isRejected: walkForwardSummary.pboScore >= config.pboRejectionThreshold,
    rankingMatrix: [],
  };

  let recommendedParams: StrategyParameterSet;
  const bestResult = walkForwardSummary.results
    .filter(r => r.testSharpe > 0)
    .sort((a, b) => b.dsr - a.dsr)[0];

  if (bestResult) {
    recommendedParams = bestResult.optimalParams;
  } else {
    recommendedParams = {
      triggerLine: 1667,
      safeRatio: 0.6,
      ambitionRatio: 0.4,
      bsmThreshold: 1.4,
      maShortWindow: 20,
      maLongWindow: 60,
      safeAllocation: { '511360': 0.8, '511880': 0.2 },
      ambitionAllocation: { '000300': 0.4, '000905': 0.4, '000922': 0.2 },
    };
  }

  const stabilityReport: StabilityReport = checkStability(
    data, symbols, recommendedParams,
    config.stabilityNeighborhoodRadius,
    config.stabilityGradientThreshold,
    riskFreeRate / 252,
  );

  if (pboResult.score >= config.pboRejectionThreshold) {
    const stableResults = walkForwardSummary.results
      .filter((r) => {
        const s = checkStability(
          data, symbols, r.optimalParams,
          config.stabilityNeighborhoodRadius,
          config.stabilityGradientThreshold,
          riskFreeRate / 252,
        );
        return r.testSharpe > 0 && s.isStable;
      })
      .sort((a, b) => b.dsr - a.dsr);

    if (stableResults.length > 0) {
      recommendedParams = stableResults[0].optimalParams;
      stabilityReport.isStable = true;
    }
  }

  return {
    timestamp,
    config,
    efficientFrontier,
    monteCarloResult,
    walkForwardSummary,
    stabilityReport,
    pboResult,
    recommendedParams,
  };
}

export function serializeReport(report: StrategyReportData): string {
  return JSON.stringify(report, (_key, value) => {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      return value > 0 ? 1e308 : -1e308;
    }
    return value;
  });
}

export async function pushReportToCloud(
  report: StrategyReportData,
  apiBaseUrl: string,
  sessionToken: string,
  _userId: number,
): Promise<{ success: boolean; error?: string }> {
  try {
    const reportJson = serializeReport(report);
    const parameterCount =
      6 +
      Object.keys(report.recommendedParams.safeAllocation).length +
      Object.keys(report.recommendedParams.ambitionAllocation).length;

    const payload = {
      report_data: reportJson,
      pbo_score: report.walkForwardSummary.pboScore,
      dsr_ranking: report.walkForwardSummary.dsrRankings[0] ?? 0,
      parameter_count: parameterCount,
      evolution_timestamp: report.timestamp,
      next_scheduled_evolution: new Date(
        new Date(report.timestamp).getTime() + 7 * 24 * 60 * 60 * 1000,
      ).toISOString(),
    };

    const response = await fetch(`${apiBaseUrl}/api/strategy/reports`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `session_token=${sessionToken}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text();
      return { success: false, error: `HTTP ${response.status}: ${body}` };
    }

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}
