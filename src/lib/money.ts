export function yuanToCents(yuan: number): number {
  if (!Number.isFinite(yuan)) return 0;
  return Math.round(yuan * 100);
}

export function centsToYuan(cents: number): number {
  return cents / 100;
}

export function formatCents(cents: number, opts: { symbol?: string; sign?: boolean } = {}): string {
  const symbol = opts.symbol ?? '¥';
  const yuan = centsToYuan(cents);
  // 默认保留负号（负值金额如实显示）；sign: true 时正数也带 +
  const prefix = opts.sign && yuan !== 0 ? (yuan > 0 ? '+' : '-') : yuan < 0 ? '-' : '';
  // 千分位分组（全库统一走这里，不再散落 toFixed 拼接）
  const grouped = Math.abs(yuan).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${prefix}${symbol}${grouped}`;
}

export function tradeDateShanghai(d: Date = new Date()): string {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 东八区当前月份（YYYY-MM）；UTC ISO 月份在每月 1 日 0-8 点会错成上月 */
export function shanghaiYearMonth(d: Date = new Date()): string {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 7);
}

export function splitDepositCents(amountCents: number, safeRatio: number): {
  safeAddedCents: number;
  ambitionAddedCents: number;
} {
  const safeAddedCents = Math.floor(amountCents * safeRatio);
  return { safeAddedCents, ambitionAddedCents: amountCents - safeAddedCents };
}
