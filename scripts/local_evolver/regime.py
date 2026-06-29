"""Regime detection using GMM on rolling features.

使用等权组合收益率的滚动特征（3M 收益率 + 3M 波动率），
通过 StandardScaler + GaussianMixture 划分三个市场状态：

  0 → Bull（牛市）
  1 → Sideways（震荡）
  2 → Bear（熊市）

使用 sklearn.mixture.GaussianMixture（轻量级，CPU 即可），
不做 HMM 以避免月频数据上的过拟合。

注意事项：
  - 必须做 StandardScaler，否则波动率数值远大于收益率会导致模型只按波动率分类。
  - 滞后平滑（hysteresis）防止状态频繁跳变。
"""

import warnings

import numpy as np
import torch
from models import MarketDataInput, RegimeResult
from sklearn.mixture import GaussianMixture
from sklearn.preprocessing import StandardScaler

warnings.filterwarnings("ignore", category=UserWarning, module="sklearn")


def _get_device() -> torch.device:
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def compute_equal_weighted_returns(
    data: MarketDataInput,
    symbols: list[str],
) -> np.ndarray:
    """计算等权组合的每日收益率序列。"""
    valid = [s for s in symbols if s in data.symbols and data.symbols[s].close]
    if not valid:
        return np.array([])

    n = min(len(data.symbols[s].close) for s in valid)
    if n < 10:
        return np.array([])

    prices = np.zeros((len(valid), n))
    for i, sym in enumerate(valid):
        prices[i] = np.array(data.symbols[sym].close[-n:], dtype=np.float64)

    eq_weights = np.ones(len(valid)) / len(valid)
    portfolio_price = eq_weights @ prices
    returns = portfolio_price[1:] / portfolio_price[:-1] - 1.0
    return returns


def extract_regime_features(
    data: MarketDataInput,
    symbols: list[str],
    lookback: int = 63,
) -> np.ndarray:
    """提取等权组合的滚动收益率和波动率特征。

    Args:
        data: 市场数据
        symbols: 资产列表
        lookback: 滚动窗口（默认 63 交易日 ≈ 3 个月）

    Returns:
        (n_obs, 2) 特征矩阵：[滚动收益率, 滚动波动率]
    """
    returns = compute_equal_weighted_returns(data, symbols)
    if len(returns) < lookback + 5:
        return np.array([])

    roll_rets = np.zeros(len(returns))
    roll_vols = np.zeros(len(returns))

    for i in range(lookback, len(returns)):
        window = returns[i - lookback : i]
        roll_rets[i] = window.mean()
        roll_vols[i] = window.std(ddof=1)

    features = np.column_stack([roll_rets[lookback:], roll_vols[lookback:]])
    features = features[~np.any(np.isnan(features) | np.isinf(features), axis=1)]

    if len(features) < 10:
        return np.array([])

    return features


def fit_gmm_regimes(
    features: np.ndarray,
    n_states: int = 3,
    random_state: int = 42,
) -> tuple[GaussianMixture, StandardScaler]:
    """拟合 GMM 并做 StandardScaler。

    Returns:
        (gmm, scaler): 训练好的 GMM 模型和标准化器
    """
    scaler = StandardScaler()
    scaled = scaler.fit_transform(features)

    gmm = GaussianMixture(
        n_components=n_states,
        covariance_type="full",
        random_state=random_state,
        max_iter=200,
        n_init=10,
    )
    gmm.fit(scaled)

    return gmm, scaler


def _hysteresis_smooth(
    labels: np.ndarray,
    window: int = 21,
) -> np.ndarray:
    """滞后平滑：用滑动窗口众数替换标签，防止状态频繁切换。"""
    smoothed = labels.copy()
    half = window // 2
    for i in range(len(labels)):
        lo = max(0, i - half)
        hi = min(len(labels), i + half + 1)
        counts = np.bincount(labels[lo:hi].astype(int), minlength=3)
        smoothed[i] = int(np.argmax(counts))
    return smoothed


def _compute_asset_returns(data: MarketDataInput, symbols: list[str]) -> np.ndarray:
    """计算各资产的日收益率矩阵 (T, n_assets)。"""
    valid = [s for s in symbols if s in data.symbols and data.symbols[s].close]
    if not valid:
        return np.array([])
    n = min(len(data.symbols[s].close) for s in valid)
    if n < 10:
        return np.array([])
    rets_list = []
    for s in symbols:
        if s in data.symbols and data.symbols[s].close:
            prices = np.array(data.symbols[s].close[-n:], dtype=np.float64)
            rets = prices[1:] / prices[:-1] - 1.0
            rets_list.append(rets)
        else:
            rets_list.append(np.zeros(n - 1))
    return np.column_stack(rets_list)


def detect_regimes(
    data: MarketDataInput,
    symbols: list[str],
    lookback: int = 63,
    n_states: int = 3,
    hysteresis_window: int = 21,
    gmm: GaussianMixture = None,
    scaler: StandardScaler = None,
) -> RegimeResult:
    """主接口：检测市场状态。

    Args:
        data: 市场数据
        symbols: 资产列表
        lookback: 滚动窗口（天）
        n_states: 固定 3 状态
        hysteresis_window: 滞后平滑窗口（天）
        gmm: 可选，已训练好的 GMM（用于在线预测）
        scaler: 可选，已训练好的 StandardScaler

    Returns:
        RegimeResult: 当前状态、概率、各状态统计信息
    """
    features = extract_regime_features(data, symbols, lookback)
    if len(features) < 10:
        return RegimeResult(
            current_regime=1,
            regime_label="Sideways",
            regime_probs=[0.33, 0.34, 0.33],
        )

    if gmm is None or scaler is None:
        gmm_fitted, scaler_fitted = fit_gmm_regimes(features, n_states)
    else:
        gmm_fitted = gmm
        scaler_fitted = scaler

    scaled = scaler_fitted.transform(features)
    raw_labels = gmm_fitted.predict(scaled)
    probs = gmm_fitted.predict_proba(scaled)

    # 根据各状态均值收益率排序，映射到 Bull(0)/Sideways(1)/Bear(2)
    returns = compute_equal_weighted_returns(data, symbols)
    feat_returns = np.zeros(n_states)
    feat_vols = np.zeros(n_states)
    for s in range(n_states):
        mask = raw_labels == s
        if mask.sum() > 0:
            feat_returns[s] = returns[-features.shape[0] :][mask].mean()
            feat_vols[s] = returns[-features.shape[0] :][mask].std(ddof=1)

    # 按 (均值收益率, -波动率) 排序，均值相同时波动率低的为 Bull
    regime_stats = [(feat_returns[s], -feat_vols[s], s) for s in range(n_states)]
    order = [s for _, _, s in sorted(regime_stats, reverse=True)]
    mapping = {old: new for new, old in enumerate(order)}
    mapped_labels = np.array([mapping[l] for l in raw_labels])

    # 滞后平滑
    smoothed = _hysteresis_smooth(mapped_labels, hysteresis_window)

    # 各状态统计
    returns_series = compute_equal_weighted_returns(data, symbols)
    full_rets = returns_series[-features.shape[0] :]

    regime_rets = []
    regime_vols = []
    regime_covs = []

    # 计算各状态下的资产协方差矩阵
    asset_rets = _compute_asset_returns(data, symbols)
    asset_rets_aligned = (
        asset_rets[-features.shape[0] :]
        if len(asset_rets) >= features.shape[0]
        else asset_rets
    )

    for s in range(n_states):
        mask = smoothed == s
        if mask.sum() > 0:
            regime_rets.append(float(full_rets[mask].mean()))
            regime_vols.append(float(full_rets[mask].std(ddof=1)))
            if mask.sum() > 1 and asset_rets_aligned.shape[0] == len(smoothed):
                subset = asset_rets_aligned[mask]
                cov_s = np.cov(subset, rowvar=False, ddof=1)
                regime_covs.append(cov_s.tolist())
            else:
                regime_covs.append([])
        else:
            regime_rets.append(0.0)
            regime_vols.append(0.0)
            regime_covs.append([])

    labels = ["Bull", "Sideways", "Bear"]

    return RegimeResult(
        current_regime=int(smoothed[-1]),
        regime_label=labels[int(smoothed[-1])],
        regime_probs=[float(p) for p in probs[-1]],
        regime_labels_series=[int(l) for l in smoothed],
        regime_covariances=regime_covs,
        regime_returns=regime_rets,
        regime_volatilities=regime_vols,
    )


def blended_covariance(
    cov_matrix: torch.Tensor,
    regime_probs: list[float],
    regime_covs: list[torch.Tensor] | None = None,
) -> torch.Tensor:
    """计算 blend 协方差：按状态概率加权平均。

    如果未提供分状态协方差，返回原协方差矩阵。
    """
    if regime_covs is None or len(regime_covs) != len(regime_probs):
        return cov_matrix

    blend = torch.zeros_like(cov_matrix)
    total_weight = sum(regime_probs)
    if total_weight <= 0:
        return cov_matrix

    for prob, cov in zip(regime_probs, regime_covs):
        blend += (prob / total_weight) * cov
    return blend
