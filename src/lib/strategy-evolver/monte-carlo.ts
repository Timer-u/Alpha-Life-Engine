import type { MarketDataInput, MonteCarloResult, PortfolioWeights } from './types';
import { computeMeanReturns, computeCovarianceMatrix } from './mpt';

function generateNormalRandom(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function choleskyDecomposition(matrix: number[][]): number[][] {
  const n = matrix.length;
  const L: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = 0;
      for (let k = 0; k < j; k++) {
        sum += L[i][k] * L[j][k];
      }

      if (i === j) {
        const val = matrix[i][i] - sum;
        if (val <= 0) {
          console.warn(`[monte-carlo] Cholesky: non-positive diagonal at ${i}, falling back to 0`);
        }
        L[i][j] = val > 0 ? Math.sqrt(val) : 0;
      } else {
        L[i][j] = (matrix[i][j] - sum) / L[j][j];
      }
    }
  }

  return L;
}

export function generateCorrelatedNormals(correlationMatrix: number[][], n: number): number[][] {
  const L = choleskyDecomposition(correlationMatrix);
  const numAssets = correlationMatrix.length;

  const samples: number[][] = [];

  for (let s = 0; s < n; s++) {
    const z: number[] = [];
    for (let i = 0; i < numAssets; i++) {
      z.push(generateNormalRandom());
    }

    const correlated: number[] = new Array(numAssets).fill(0);
    for (let i = 0; i < numAssets; i++) {
      for (let j = 0; j <= i; j++) {
        correlated[i] += L[i][j] * z[j];
      }
    }

    samples.push(correlated);
  }

  return samples;
}

export function covarianceToCorrelation(covMatrix: number[][]): { corrMatrix: number[][]; stdDevs: number[] } {
  const n = covMatrix.length;
  const stdDevs = covMatrix.map((row, i) => Math.sqrt(Math.max(0, row[i])));
  const corrMatrix: number[][] = [];

  for (let i = 0; i < n; i++) {
    corrMatrix[i] = [];
    for (let j = 0; j < n; j++) {
      if (stdDevs[i] === 0 || stdDevs[j] === 0) {
        corrMatrix[i][j] = i === j ? 1 : 0;
      } else {
        corrMatrix[i][j] = covMatrix[i][j] / (stdDevs[i] * stdDevs[j]);
      }
    }
  }

  return { corrMatrix, stdDevs };
}

export function generateCorrelatedGBMPaths(
  initialPrices: number[],
  annualizedReturns: number[],
  annualizedVolatilities: number[],
  covarianceMatrix: number[][],
  days: number,
  numPaths: number,
): number[][][] {
  const numAssets = initialPrices.length;
  const dt = 1 / 252;
  const paths: number[][][] = [];

  const { corrMatrix } = covarianceToCorrelation(covarianceMatrix);
  const dailyDrifts = annualizedReturns.map(mu => mu * dt);
  const dailyVols = annualizedVolatilities.map(sigma => sigma * Math.sqrt(dt));

  for (let path = 0; path < numPaths; path++) {
    const pricePath: number[][] = [initialPrices.slice()];

    for (let t = 1; t <= days; t++) {
      const shocks = generateCorrelatedNormals(corrMatrix, 1)[0];
      const prevPrices = pricePath[t - 1];
      const currentPrices: number[] = [];

      for (let a = 0; a < numAssets; a++) {
        const drift = dailyDrifts[a] - (dailyVols[a] * dailyVols[a]) / 2;
        const price = prevPrices[a] * Math.exp(drift + dailyVols[a] * shocks[a]);
        currentPrices.push(price);
      }

      pricePath.push(currentPrices);
    }

    paths.push(pricePath);
  }

  return paths;
}

export function generateGBMPath(
  initialPrice: number,
  annualizedReturn: number,
  annualizedVolatility: number,
  days: number,
): number[] {
  return generateCorrelatedGBMPaths(
    [initialPrice],
    [annualizedReturn],
    [annualizedVolatility],
    [[1]],
    days,
    1,
  )[0].map(p => p[0]);
}

function computeDrawdown(prices: number[]): number[] {
  let peak = prices[0];
  return prices.map((price) => {
    if (price > peak) peak = price;
    return (price - peak) / peak;
  });
}

function computeMaxDrawdown(prices: number[]): number {
  const drawdowns = computeDrawdown(prices);
  return Math.min(...drawdowns);
}

export function computePortfolioPathReturns(
  paths: number[][][],
  weights: number[],
): number[][] {
  return paths.map((assetPaths) => {
    const portfolioValues = assetPaths.map(assetPrices =>
      assetPrices.reduce((sum, price, i) => sum + price * weights[i], 0),
    );
    const initialValue = portfolioValues[0];
    return portfolioValues.map(v => v / initialValue - 1);
  });
}

export function computeMonteCarloSummary(
  portfolioReturns: number[][],
  portfolioValues: number[][],
): MonteCarloResult['summary'] {
  const finalReturns = portfolioReturns.map(path => path[path.length - 1]);
  const sorted = [...finalReturns].sort((a, b) => a - b);
  const n = sorted.length;

  const meanReturn = sorted.reduce((s, r) => s + r, 0) / n;
  const medianReturn = sorted[Math.floor(n * 0.5)];
  const variance = sorted.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / (n - 1);
  const stdReturn = Math.sqrt(variance);

  const var95 = sorted[Math.floor(n * 0.05)];
  const var99 = sorted[Math.floor(n * 0.01)];

  const maxDrawdowns = portfolioValues.map(computeMaxDrawdown);
  const maxDrawdown = maxDrawdowns.reduce((min, dd) => Math.min(min, dd), 0);

  const p1 = sorted[Math.floor(n * 0.01)] || 0;
  const p5 = var95;
  const p10 = sorted[Math.floor(n * 0.10)] || 0;
  const p25 = sorted[Math.floor(n * 0.25)] || 0;
  const p50 = medianReturn;
  const p75 = sorted[Math.floor(n * 0.75)] || 0;
  const p90 = sorted[Math.floor(n * 0.90)] || 0;
  const p95 = sorted[Math.floor(n * 0.95)] || 0;
  const p99 = sorted[Math.floor(n * 0.99)] || 0;

  return {
    meanReturn,
    medianReturn,
    stdReturn,
    var95,
    var99,
    maxDrawdown,
    percentiles: { p1, p5, p10, p25, p50, p75, p90, p95, p99 },
  };
}

export function runMonteCarlo(
  data: MarketDataInput,
  symbols: string[],
  weights: PortfolioWeights,
  initialPrices: number[],
  days: number = 252,
  numPaths: number = 10000,
): MonteCarloResult {
  const meanReturns = computeMeanReturns(data, symbols);
  const covMatrix = computeCovarianceMatrix(data, symbols);
  const annualizedReturns = meanReturns.map(r => r * 252);
  const annualizedVolatilities = covMatrix.map((_, i) => Math.sqrt(covMatrix[i][i] * 252));

  const weightArray = symbols.map(s => weights[s] ?? 0);

  const rawPaths = generateCorrelatedGBMPaths(
    initialPrices,
    annualizedReturns,
    annualizedVolatilities,
    covMatrix,
    days,
    numPaths,
  );

  const portfolioReturns = computePortfolioPathReturns(rawPaths, weightArray);
  const portfolioValues = rawPaths.map(paths => 
    paths.map(p => p.reduce((sum, price, i) => sum + price * weightArray[i], 0)),
  );

  const summary = computeMonteCarloSummary(portfolioReturns, portfolioValues);

  const priceTransposed: number[][] = [];
  const returnTransposed: number[][] = [];

  const numTimeSteps = rawPaths[0]?.length ?? 0;
  for (let t = 0; t < numTimeSteps; t++) {
    priceTransposed[t] = [];
    returnTransposed[t] = [];
    for (let p = 0; p < Math.min(numPaths, 1000); p++) {
      priceTransposed[t][p] = rawPaths[p][t].reduce(
        (sum, price, i) => sum + price * weightArray[i], 0,
      );
      returnTransposed[t][p] = portfolioReturns[p][t];
    }
  }

  const dates: string[] = [];
  const startDate = new Date();
  for (let t = 0; t <= days; t++) {
    const d = new Date(startDate);
    d.setDate(d.getDate() + t);
    dates.push(d.toISOString().split('T')[0]);
  }

  return {
    paths: {
      dates,
      prices: priceTransposed,
      returns: returnTransposed,
    },
    summary,
  };
}
