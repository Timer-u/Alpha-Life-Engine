"""Risk decomposition: Marginal Risk Contribution (MRC).

     MRC_i = w_i * (Σw)_i  /  (w'Σw)

其中 w_i 为第 i 个资产的权重，Σ 为协方差矩阵，(Σw)_i 为协方差矩阵与权重向量的第 i 个分量。

直接计算 MRC，不使用 PCA（3-5 个资产无法提取有意义的主成分）。
"""

import torch
from models import EfficientFrontier, MRCResult


def _get_device() -> torch.device:
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def compute_mrc(
    weights: dict[str, float],
    symbols: list[str],
    cov_matrix: torch.Tensor,
) -> MRCResult:
    """计算各资产的 Marginal Risk Contribution。

    Args:
        weights: {symbol: weight} 权重字典
        symbols: 资产标签列表（顺序与 cov_matrix 的行/列对应）
        cov_matrix: (n_assets, n_assets) 协方差矩阵

    Returns:
        MRCResult: 各资产 MRC、Component VaR、总方差
    """
    w = torch.tensor(
        [weights.get(s, 0.0) for s in symbols],
        device=cov_matrix.device,
        dtype=cov_matrix.dtype,
    )

    sigma_w = cov_matrix @ w
    portfolio_variance = (w * sigma_w).sum()
    total_var = float(portfolio_variance.item())

    if total_var <= 0:
        equal_mrc = 1.0 / max(len(symbols), 1)
        return MRCResult(
            mrc=dict.fromkeys(symbols, equal_mrc),
            component_var=dict.fromkeys(symbols, 0.0),
            total_var=0.0,
        )

    mrc_values = w * sigma_w / portfolio_variance

    mrc_dict = {}
    component_var_dict = {}
    for i, sym in enumerate(symbols):
        mrc_val = float(mrc_values[i].item())
        mrc_dict[sym] = mrc_val
        component_var_dict[sym] = mrc_val * total_var

    return MRCResult(
        mrc=mrc_dict,
        component_var=component_var_dict,
        total_var=total_var,
    )


def compute_mrc_for_frontier(
    efficient_frontier: EfficientFrontier,
    symbols: list[str],
    cov_matrix: torch.Tensor,
) -> list[MRCResult]:
    """为有效前沿上的所有点计算 MRC。"""
    results = []
    for point in efficient_frontier.points:
        mrc = compute_mrc(point.weights.weights, symbols, cov_matrix)
        results.append(mrc)
    return results
