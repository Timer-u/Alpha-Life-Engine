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
  const prefix = opts.sign && yuan !== 0 ? (yuan > 0 ? '+' : '-') : '';
  return `${prefix}${symbol}${Math.abs(yuan).toFixed(2)}`;
}

export function tradeDateShanghai(d: Date = new Date()): string {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

export function splitDepositCents(amountCents: number, safeRatio: number): {
  safeAddedCents: number;
  ambitionAddedCents: number;
} {
  const safeAddedCents = Math.floor(amountCents * safeRatio);
  return { safeAddedCents, ambitionAddedCents: amountCents - safeAddedCents };
}
