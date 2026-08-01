import type { Env } from './[[route]]';

import { logNotification, sendEmail, strategyExpiryEmailHtml, wasRecentlyNotified } from './email';
import { STALE_DAYS } from './lch-utils';

// 同类提醒最短间隔（天），防止每日 cron 重复轰炸
const REMIND_INTERVAL_DAYS = 7;

interface StaleReportRow {
  user_id: number;
  email: string;
  evolution_timestamp: string;
  next_scheduled_evolution: string | null;
}

/**
 * 定时任务（cron 触发）：检查每个用户最新策略报告是否过期，
 * 过期则发送提醒邮件（7 天内最多一次）。
 */
export async function runScheduledNotifications(env: Env): Promise<void> {
  const db = env.DB;
  const now = Date.now();

  const rows = await db.prepare(
    `SELECT u.id AS user_id, u.email, sr.evolution_timestamp, sr.next_scheduled_evolution
     FROM users u
     JOIN strategy_reports sr ON sr.user_id = u.id
     WHERE sr.evolution_timestamp = (
       SELECT MAX(s2.evolution_timestamp) FROM strategy_reports s2 WHERE s2.user_id = u.id
     )`
  ).all<StaleReportRow>();

  for (const row of rows.results) {
    const lastMs = new Date(row.evolution_timestamp).getTime();
    if (isNaN(lastMs)) continue;

    const daysSince = Math.floor((now - lastMs) / (24 * 60 * 60 * 1000));
    const nextDueMs = row.next_scheduled_evolution ? new Date(row.next_scheduled_evolution).getTime() : NaN;
    const overdue = daysSince > STALE_DAYS || (!isNaN(nextDueMs) && nextDueMs < now);
    if (!overdue) continue;

    try {
      if (await wasRecentlyNotified(db, row.user_id, 'strategy_expiry', REMIND_INTERVAL_DAYS)) continue;

      const sent = await sendEmail(
        env.RESEND_API_KEY,
        row.email,
        `策略演化器已 ${daysSince} 天未更新`,
        strategyExpiryEmailHtml(daysSince, row.evolution_timestamp)
      );
      if (sent) {
        await logNotification(db, row.user_id, 'strategy_expiry');
      }
    } catch (error) {
      console.error(`Failed to notify user ${row.user_id}:`, error);
    }
  }
}
