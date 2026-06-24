import { describe, it, expect } from 'vitest';
import { choleskyDecomposition, covarianceToCorrelation } from '../monte-carlo';

describe('choleskyDecomposition', () => {
  it('returns lower triangular L for a 2x2 PD matrix', () => {
    const A = [[4, 2], [2, 5]];
    const L = choleskyDecomposition(A);
    expect(L[0][0]).toBeCloseTo(2, 10);
    expect(L[1][0]).toBeCloseTo(1, 10);
    expect(L[1][1]).toBeCloseTo(2, 10);
    expect(L[0][1]).toBe(0);
  });

  it('reconstructs A from L*L^T', () => {
    const A = [[25, 15, -5], [15, 18, 0], [-5, 0, 11]];
    const L = choleskyDecomposition(A);
    const n = A.length;
    const reconstructed: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        for (let k = 0; k < n; k++) {
          reconstructed[i][j] += L[i][k] * L[j][k];
        }
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        expect(reconstructed[i][j]).toBeCloseTo(A[i][j], 8);
      }
    }
  });

  it('handles identity matrix', () => {
    const I = [[1, 0], [0, 1]];
    const L = choleskyDecomposition(I);
    expect(L[0][0]).toBeCloseTo(1, 10);
    expect(L[1][1]).toBeCloseTo(1, 10);
  });

  it('handles 1x1 matrix', () => {
    const L = choleskyDecomposition([[9]]);
    expect(L[0][0]).toBeCloseTo(3, 10);
  });
});

describe('covarianceToCorrelation', () => {
  it('converts covariance to correlation matrix', () => {
    const cov = [[4, 2], [2, 9]];
    const { corrMatrix, stdDevs } = covarianceToCorrelation(cov);
    expect(stdDevs[0]).toBeCloseTo(2, 10);
    expect(stdDevs[1]).toBeCloseTo(3, 10);
    expect(corrMatrix[0][1]).toBeCloseTo(2 / (2 * 3), 10);
    expect(corrMatrix[1][0]).toBeCloseTo(2 / (2 * 3), 10);
    expect(corrMatrix[0][0]).toBe(1);
    expect(corrMatrix[1][1]).toBe(1);
  });

  it('handles zero variance', () => {
    const cov = [[0, 0], [0, 1]];
    const { corrMatrix } = covarianceToCorrelation(cov);
    expect(corrMatrix[0][1]).toBe(0);
    expect(corrMatrix[1][1]).toBe(1);
  });
});
