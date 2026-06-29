"""Sobol sensitivity analysis for strategy parameters.

使用 Saltelli 采样计算一阶和总效应 Sobol 指标。

Saltelli 采样设计：
  - 基础矩阵 A, B: (N, D)
  - 对每个参数 i，构造 A_B(i)：将 A 的第 i 列替换为 B 的第 i 列
  - 总评估次数: N * (D + 2)

一阶 Sobol:  S_i = Var(E[Y|X_i]) / Var(Y)
总效应 Sobol: S_Ti = 1 - Var(E[Y|X_{-i}]) / Var(Y)
"""

from collections.abc import Callable

import numpy as np


def _sobol_sample(
    n: int,
    d: int,
    bounds: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """生成 Saltelli 采样矩阵 A, B。

    Args:
        n: Saltelli N
        d: 参数维度
        bounds: (d, 2) each row [lo, hi]

    Returns:
        A, B: (n, d) arrays in [0,1] space
    """
    rng = np.random.default_rng(42)
    A = rng.random((n, d))
    B = rng.random((n, d))
    return A, B


def _scale_params(
    samples: np.ndarray,
    bounds: np.ndarray,
) -> np.ndarray:
    """将 [0,1] 采样缩放到实际参数范围。"""
    lo = bounds[:, 0]
    hi = bounds[:, 1]
    return lo + samples * (hi - lo)


def _build_saltelli_matrices(
    A: np.ndarray,
    B: np.ndarray,
    d: int,
) -> np.ndarray:
    """构建 Saltelli 完整矩阵集。

    Returns: shape (n * (d + 2), d)
    """
    n = A.shape[0]
    matrices = [A, B]
    for i in range(d):
        AB = B.copy()
        AB[:, i] = A[:, i]
        matrices.append(AB)
    return np.vstack(matrices)


def compute_sobol_indices(
    model_fn: Callable[[np.ndarray], np.ndarray],
    param_names: list[str],
    bounds: np.ndarray,
    n: int = 2048,
) -> dict:
    """计算 Sobol 一阶和总效应指标。

    Args:
        model_fn: 接受 (M, d) 参数矩阵，返回 (M,) 评分向量
        param_names: 参数名称列表
        bounds: (d, 2) [lo, hi] 边界
        n: Saltelli N（默认 2048）

    Returns:
        dict with "first_order", "total_order", "confidence_first", "confidence_total"
    """
    d = len(param_names)
    A_raw, B_raw = _sobol_sample(n, d, bounds)

    X = _build_saltelli_matrices(A_raw, B_raw, d)
    X_scaled = _scale_params(X, bounds)

    Y = model_fn(X_scaled)

    n_total = X.shape[0]
    Y = Y.reshape(-1)

    YA = Y[:n]
    YB = Y[n : 2 * n]

    Y_AB = []
    for i in range(d):
        start = (2 + i) * n
        end = (3 + i) * n
        Y_AB.append(Y[start:end])

    var_y = np.var(Y, ddof=1)
    if var_y <= 1e-15:
        return _zero_result(param_names)

    first_order = {}
    total_order = {}
    ci_first = {}
    ci_total = {}

    for i in range(d):
        y_ab = Y_AB[i]

        si = 2.0 * (np.cov(YA, y_ab)[0, 1]) / var_y if len(YA) > 1 else 0.0
        si = np.clip(si, -1.0, 1.0)

        sti = 1.0 - 2.0 * (np.cov(y_ab, YB)[0, 1]) / var_y if len(YB) > 1 else 1.0
        sti = np.clip(sti, -1.0, 1.0)

        first_order[param_names[i]] = float(si)
        total_order[param_names[i]] = float(sti)

        n_boot = 200
        boot_si = []
        boot_sti = []
        rng = np.random.default_rng(42)
        for _ in range(n_boot):
            idx = rng.choice(n, n, replace=True)
            YA_boot = YA[idx]
            y_ab_boot = y_ab[idx]
            YB_boot = YB[idx]
            var_y_boot = np.var(Y[idx], ddof=1)
            if var_y_boot <= 1e-15:
                continue
            si_boot = (
                2.0 * np.cov(YA_boot, y_ab_boot)[0, 1] / var_y_boot
                if len(YA_boot) > 1
                else 0.0
            )
            boot_si.append(np.clip(si_boot, -1.0, 1.0))

            sti_boot = (
                1.0 - 2.0 * np.cov(y_ab_boot, YB_boot)[0, 1] / var_y_boot
                if len(YB_boot) > 1
                else 1.0
            )
            boot_sti.append(np.clip(sti_boot, -1.0, 1.0))

        ci_first[param_names[i]] = (
            float(np.percentile(boot_si, 5)),
            float(np.percentile(boot_si, 95)),
        )
        ci_total[param_names[i]] = (
            float(np.percentile(boot_sti, 5)),
            float(np.percentile(boot_sti, 95)),
        )

    return {
        "first_order": first_order,
        "total_order": total_order,
        "confidence_first": ci_first,
        "confidence_total": ci_total,
    }


def _zero_result(param_names: list[str]) -> dict:
    return {
        "first_order": dict.fromkeys(param_names, 0.0),
        "total_order": dict.fromkeys(param_names, 0.0),
        "confidence_first": dict.fromkeys(param_names, (0.0, 0.0)),
        "confidence_total": dict.fromkeys(param_names, (0.0, 0.0)),
    }
