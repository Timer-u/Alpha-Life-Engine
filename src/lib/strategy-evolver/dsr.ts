const SQRT_2 = Math.SQRT2;

function erf(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x >= 0 ? 1 : -1;
  x = Math.abs(x);

  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return sign * y;
}

export function normalCDF(x: number): number {
  return 0.5 * (1 + erf(x / SQRT_2));
}

export function normalInvCDF(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;

  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  let x: number;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
      / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -((((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1));
  }

  return x;
}

export function computeSharpeRatio(returns: number[], riskFreeRate: number = 0): number {
  const n = returns.length;
  if (n < 2) return 0;

  const mean = returns.reduce((s, r) => s + r, 0) / n;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1);
  const std = Math.sqrt(variance);

  if (std === 0) return 0;

  return (mean - riskFreeRate) / std;
}

export function computeSkewness(returns: number[]): number {
  const n = returns.length;
  if (n < 3) return 0;

  const mean = returns.reduce((s, r) => s + r, 0) / n;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1);
  const std = Math.sqrt(variance);

  if (std === 0) return 0;

  const m3 = returns.reduce((s, r) => s + (r - mean) ** 3, 0) / n;
  return m3 / (std ** 3);
}

export function computeKurtosis(returns: number[]): number {
  const n = returns.length;
  if (n < 4) return 0;

  const mean = returns.reduce((s, r) => s + r, 0) / n;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1);
  const std = Math.sqrt(variance);

  if (std === 0) return 0;

  const m4 = returns.reduce((s, r) => s + (r - mean) ** 4, 0) / n;
  return m4 / (std ** 4) - 3;
}

export function annualizeReturn(periodReturn: number, periodsPerYear: number): number {
  return Math.pow(1 + periodReturn, periodsPerYear) - 1;
}

export function annualizeVolatility(periodStd: number, periodsPerYear: number): number {
  return periodStd * Math.sqrt(periodsPerYear);
}

export function computeAnnualizedSharpe(dailyReturns: number[], riskFreeRate: number = 0): number {
  const dailySharpe = computeSharpeRatio(dailyReturns, riskFreeRate / 252);
  return dailySharpe * Math.sqrt(252);
}

export function computeDSR(
  sharpe: number,
  n: number,
  skewness: number = 0,
  alpha: number = 0.05,
  excessKurtosis: number = 0,
): number {
  if (n < 2) return 0;

  const denomSq = 1 - skewness * sharpe + ((excessKurtosis + 2) / 4) * sharpe * sharpe;

  if (denomSq <= 0) {
    return 0;
  }

  const denominator = Math.sqrt(denomSq);
  const numerator = sharpe * Math.sqrt(n - 1) - normalInvCDF(1 - alpha);
  const dsrZ = numerator / denominator;

  return normalCDF(dsrZ);
}

export function computeSharpeMeanStdRatio(
  sharpeValues: number[],
): number {
  return computeSharpeRatio(sharpeValues);
}
