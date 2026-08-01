import { describe, expect, it } from 'vitest';

import { logNotification, wasRecentlyNotified } from '../email';

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
