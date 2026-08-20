const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface MarketRow {
  symbol: string;
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number;
}

export class MarketValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`market data validation failed: ${errors.join('; ')}`);
    this.name = 'MarketValidationError';
  }
}

function toNumberOrNull(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function validateMarketRow(fields: Record<string, string | undefined>, lineNo: number): MarketRow {
  const errors: string[] = [];
  const { symbol, date, open: openRaw, high: highRaw, low: lowRaw, close: closeRaw, volume: volumeRaw } = fields;
  const open = toNumberOrNull(openRaw);
  const high = toNumberOrNull(highRaw);
  const low = toNumberOrNull(lowRaw);
  const close = Number(closeRaw);
  const volume = Number(volumeRaw ?? '');

  if (!symbol) errors.push(`line ${lineNo}: missing symbol`);
  if (!date || !ISO_DATE_RE.test(date)) errors.push(`line ${lineNo}: invalid date '${date}'`);
  if (!Number.isFinite(close) || close <= 0) errors.push(`line ${lineNo}: close must be a number > 0, got '${closeRaw}'`);
  if (open !== null && !Number.isFinite(Number(openRaw))) errors.push(`line ${lineNo}: open must be a number, got '${openRaw}'`);
  if (high !== null && !Number.isFinite(Number(highRaw))) errors.push(`line ${lineNo}: high must be a number, got '${highRaw}'`);
  if (low !== null && !Number.isFinite(Number(lowRaw))) errors.push(`line ${lineNo}: low must be a number, got '${lowRaw}'`);
  if (high !== null && low !== null && high < low) errors.push(`line ${lineNo}: high (${high}) < low (${low})`);
  if (volumeRaw !== undefined && volumeRaw.trim() !== '' && (!Number.isInteger(volume) || volume < 0)) {
    errors.push(`line ${lineNo}: volume must be a non-negative integer, got '${volumeRaw}'`);
  }
  if (errors.length > 0) throw new MarketValidationError(errors);
  return { symbol: symbol ?? '', date: date ?? '', open, high, low, close, volume };
}

export function parseMarketCsv(csvText: string): MarketRow[] {
  const lines = csvText.split('\n');
  const rows: MarketRow[] = [];
  const allErrors: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
    if (cols.length < 6) {
      allErrors.push(`line ${i + 1}: expected at least 6 columns, got ${cols.length}`);
      continue;
    }
    const [date, code, open, high, low, close, volume = ''] = cols;
    try {
      rows.push(validateMarketRow({ symbol: code.replace(/^(sh|sz)\./, ''), date, open, high, low, close, volume }, i + 1));
    } catch (e) {
      if (e instanceof MarketValidationError) allErrors.push(...e.errors);
      else throw e;
    }
  }
  if (allErrors.length > 0) throw new MarketValidationError(allErrors);
  return rows;
}

export function findMissingSymbols(presentSymbols: readonly string[], expected: readonly string[]): string[] {
  const seen = new Set(presentSymbols);
  return expected.filter(s => !seen.has(s));
}
