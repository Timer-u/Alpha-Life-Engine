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
    expect(html).toContain('¥1667.00');
    expect(html).toContain('¥1000.00');
    expect(html).toContain('¥667.00');
    expect(html).toContain('¥0.50');
  });
});
