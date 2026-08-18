import { describe, expect, it } from 'vitest';

import { findMissingSymbols, MarketValidationError, parseMarketCsv } from '../market-validation';

const CSV_HEADER = 'date,code,open,high,low,close,volume,amount';

describe('parseMarketCsv', () => {
  it('parses a valid CSV, stripping exchange prefixes and quotes', () => {
    const csv = [
      CSV_HEADER,
      '2026-08-13,sh.511360,100.0,100.5,99.8,100.1,1200,120000.0',
      '"2026-08-12","sh.511880","100.0","100.4","99.9","100.2","800","80000.0"',
    ].join('\n');
    const rows = parseMarketCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ symbol: '511360', date: '2026-08-13', open: 100.0, high: 100.5, low: 99.8, close: 100.1, volume: 1200 });
    expect(rows[1].symbol).toBe('511880');
  });

  it('returns [] for header-only input', () => {
    expect(parseMarketCsv(CSV_HEADER)).toEqual([]);
  });

  it('defaults missing volume to 0 and tolerates empty OHLC', () => {
    const rows = parseMarketCsv([CSV_HEADER, '2026-08-13,sh.511360,,, ,100.1,'].join('\n'));
    expect(rows[0]).toEqual({ symbol: '511360', date: '2026-08-13', open: null, high: null, low: null, close: 100.1, volume: 0 });
  });

  it('rejects close <= 0 or non-numeric', () => {
    expect(() => parseMarketCsv([CSV_HEADER, '2026-08-13,sh.511360,1,2,1,0,10'].join('\n'))).toThrow(MarketValidationError);
    expect(() => parseMarketCsv([CSV_HEADER, '2026-08-13,sh.511360,1,2,1,abc,10'].join('\n'))).toThrow(/line 2/);
  });

  it('rejects high < low', () => {
    expect(() => parseMarketCsv([CSV_HEADER, '2026-08-13,sh.511360,1,1,2,1.5,10'].join('\n'))).toThrow(/high/);
  });

  it('rejects malformed dates', () => {
    expect(() => parseMarketCsv([CSV_HEADER, '2026/08/13,sh.511360,1,2,1,1.5,10'].join('\n'))).toThrow(/date/);
  });

  it('rejects rows with fewer than 6 columns', () => {
    expect(() => parseMarketCsv([CSV_HEADER, '2026-08-13,sh.511360,1,2'].join('\n'))).toThrow(/line 2/);
  });

  it('aggregates multiple row errors in one exception', () => {
    const csv = [CSV_HEADER, '2026-08-13,sh.511360,1,1,2,1.5,10', '2026-08-12,sh.511880,1,1,2,1.5,10'].join('\n');
    try {
      parseMarketCsv(csv);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MarketValidationError);
      expect((e as MarketValidationError).errors).toHaveLength(2);
    }
  });
});

describe('findMissingSymbols', () => {
  it('returns expected symbols absent from the rows', () => {
    const rows = parseMarketCsv([CSV_HEADER, '2026-08-13,sh.511360,1,2,1,1.5,10'].join('\n'));
    expect(findMissingSymbols(rows.map(r => r.symbol), ['511360', '511880', '511990'])).toEqual(['511880', '511990']);
    expect(findMissingSymbols(rows.map(r => r.symbol), ['511360'])).toEqual([]);
  });
});