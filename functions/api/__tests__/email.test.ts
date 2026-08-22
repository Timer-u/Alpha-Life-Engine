import { describe, expect, it } from 'vitest';

import { executionSuggestionEmailHtml, logNotification, wasRecentlyNotified } from '../email';

import { asD1, FakeD1 } from './helpers/fake-d1';

function notificationDb(rows: unknown[]): FakeD1 {
  return new FakeD1([
    { match: sql => sql.includes('FROM notification_log'), rows },
    { match: sql => sql.includes('INSERT INTO notification_log'), rows: [] },
  ]);
}

describe('wasRecentlyNotified', () => {
  it('returns true when a notification was logged within the window', async () => {
    const db = notificationDb([{ id: 1 }]);
    expect(await wasRecentlyNotified(asD1(db), 7, 'execution_suggestion', 1)).toBe(true);
  });

  it('returns false when no notification was logged within the window', async () => {
    const db = notificationDb([]);
    expect(await wasRecentlyNotified(asD1(db), 7, 'execution_suggestion', 1)).toBe(false);
  });
});

describe('logNotification', () => {
  it('inserts a notification log entry without throwing', async () => {
    const db = notificationDb([]);
    await expect(logNotification(asD1(db), 7, 'strategy_expiry')).resolves.toBeUndefined();
  });
});

describe('executionSuggestionEmailHtml', () => {
  it('displays cents amounts as yuan', () => {
    const html = executionSuggestionEmailHtml({
      executedAmount: 166700,
      safeAmount: 100000,
      ambitionAmount: 66700,
      commission: 50,
      nextSafeEtf: '511360',
      nextSafeEtfName: '测试ETF',
      message: '触发条件已满足',
    });
    // formatCents 全库千分位分组
    expect(html).toContain('¥1,667.00');
    expect(html).toContain('¥1,000.00');
    expect(html).toContain('¥667.00');
    expect(html).toContain('¥0.50');
  });

  it('renders the ambition ETF suggestion when provided', () => {
    const html = executionSuggestionEmailHtml({
      executedAmount: 166700,
      safeAmount: 100000,
      ambitionAmount: 66700,
      commission: 50,
      nextSafeEtf: '511360',
      nextSafeEtfName: '海富通短融ETF',
      nextAmbitionEtf: '510500',
      nextAmbitionEtfName: '中证500 ETF',
      message: '触发条件已满足',
    });
    expect(html).toContain('进取层建议标的');
    expect(html).toContain('中证500 ETF');
  });

  it('falls back to a dash when the ambition ETF is omitted', () => {
    const html = executionSuggestionEmailHtml({
      executedAmount: 166700,
      safeAmount: 100000,
      ambitionAmount: 66700,
      commission: 50,
      nextSafeEtf: '511360',
      nextSafeEtfName: '海富通短融ETF',
      message: '触发条件已满足',
    });
    expect(html).toContain('进取层建议标的</td><td style="text-align:right;font-family:monospace;">-</td>');
  });
});
