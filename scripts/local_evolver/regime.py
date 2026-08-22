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
from models import MarketDataInput, RegimeResult
from sklearn.mixture import GaussianMixture
from sklearn.preprocessing import StandardScaler
from walk_forward import extract_prices_for_symbols

warnings.filterwarnings("ignore", category=UserWarning, module="sklearn")


def _returns_rowwise(prices: np.ndarray) -> np.ndarray:
    """逐日收益（第 0 日为 0），NaN 价格传播为 NaN。"""
    rets = np.zeros(len(prices))
    if len(prices) > 1:
        with np.errstate(divide="ignore", invalid="ignore"):
            rets[1:] = prices[1:] / prices[:-1] - 1.0
    return rets


def compute_equal_weighted_returns(
    data: MarketDataInput,
    symbols: list[str],
) -> np.ndarray:
    """等权组合的每日收益率序列（日期对齐，逐日按可交易标的权重再归一）。

    旧的 min(len) 尾部截断会在停牌/缺日时静默错位各标的；这里复用
    walk_forward 的日期对齐矩阵，每日均值只在当日有数据的标的间计算
    （晚上市标的上市前不计入），全部标的缺数据的日子为 NaN（响亮）。
    """
    valid = [s for s in symbols if s in data.symbols and data.symbols[s].close]
    if not valid:
        return np.array([])
    try:
        aligned = extract_prices_for_symbols(data, valid)
    except ValueError:
        return np.array([])

    rets = np.column_stack([_returns_rowwise(p) for p in aligned])
    finite = np.isfinite(rets)
    counts = finite.sum(axis=1)
    sums = np.where(finite, rets, 0.0).sum(axis=1)
    mean_rets = np.full(rets.shape[0], np.nan)
    has_data = counts > 0
    mean_rets[has_data] = sums[has_data] / counts[has_data]
    # 第 0 日是占位 0 收益，剔除
    return mean_rets[1:]


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
    """各资产的日收益率矩阵 (T-1, n_assets)，列序与 symbols 一致。

    日期对齐替代旧的 min(len) 尾部截断；缺失日的行保留 NaN，由调用方
    在逐状态协方差估计时做 listwise 剔除（不能进 np.cov 毒化结果）。
    """
    valid = [s for s in symbols if s in data.symbols and data.symbols[s].close]
    if not valid:
        return np.array([])
    try:
        aligned = extract_prices_for_symbols(data, valid)
    except ValueError:
        return np.array([])
    by_symbol = dict(zip(valid, aligned, strict=True))
    master_len = aligned[0].shape[0]
    cols = []
    for s in symbols:
        prices = by_symbol.get(s)
        cols.append(
            _returns_rowwise(prices) if prices is not None else np.zeros(master_len)
        )
    rets = np.column_stack(cols)
    return rets[1:]


def _regime_statistics(
    smoothed: np.ndarray,
    full_rets: np.ndarray,
    asset_rets_aligned: np.ndarray,
    n_states: int,
) -> tuple[list[float], list[float], list[list[list[float]]]]:
    """逐状态的收益均值/波动与资产协方差（协方差按完整截面 listwise 剔除）。"""
    regime_rets: list[float] = []
    regime_vols: list[float] = []
    regime_covs: list[list[list[float]]] = []
    labels_align = asset_rets_aligned.shape[0] == len(smoothed)

    for s in range(n_states):
        mask = smoothed == s
        if mask.sum() == 0:
            regime_rets.append(0.0)
            regime_vols.append(0.0)
            regime_covs.append([])
            continue
        segment = full_rets[mask]
        finite = segment[np.isfinite(segment)]
        regime_rets.append(float(finite.mean()) if len(finite) else 0.0)
        regime_vols.append(float(finite.std(ddof=1)) if len(finite) > 1 else 0.0)

        cov_rows = []
        if mask.sum() > 1 and labels_align:
            subset = asset_rets_aligned[mask]
            # listwise 剔除当日任一标的无数据的行，NaN 进 np.cov 会毒化整阵
            subset = subset[np.all(np.isfinite(subset), axis=1)]
            if subset.shape[0] > 1:
                cov_rows = np.cov(subset, rowvar=False, ddof=1).tolist()
        regime_covs.append(cov_rows)

    return regime_rets, regime_vols, regime_covs


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
            segment = returns[-features.shape[0] :][mask]
            finite = segment[np.isfinite(segment)]
            feat_returns[s] = finite.mean() if len(finite) else 0.0
            feat_vols[s] = finite.std(ddof=1) if len(finite) > 1 else 0.0

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

    # 计算各状态下的资产协方差矩阵
    asset_rets = _compute_asset_returns(data, symbols)
    asset_rets_aligned = (
        asset_rets[-features.shape[0] :]
        if len(asset_rets) >= features.shape[0]
        else asset_rets
    )

    regime_rets, regime_vols, regime_covs = _regime_statistics(
        smoothed, full_rets, asset_rets_aligned, n_states
    )

    labels = ["Bull", "Sideways", "Bear"]

    # 概率列必须与标签走同一个重排（order[new] = 旧分量），
    # 否则三概率按 GMM 内部分量序输出、与 regime_label 错位
    remapped_probs = probs[:, order]

    return RegimeResult(
        current_regime=int(smoothed[-1]),
        regime_label=labels[int(smoothed[-1])],
        regime_probs=[float(p) for p in remapped_probs[-1]],
        regime_labels_series=[int(l) for l in smoothed],
        regime_covariances=regime_covs,
        regime_returns=regime_rets,
        regime_volatilities=regime_vols,
    )
