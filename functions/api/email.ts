// 邮件发送与通知记录工具（Resend）
// RESEND_API_KEY 未配置时降级为控制台输出（与 OTP 邮件行为一致）

import { formatCents } from '../../src/lib/money';

const FROM_ADDRESS = 'no-reply@alpha-life.yourdomain.com';

export type NotificationType = 'strategy_expiry' | 'execution_suggestion';

export async function sendEmail(apiKey: string, to: string, subject: string, html: string): Promise<boolean> {
  if (!apiKey) {
    console.warn(`[DEV] Email -> ${to}: ${subject}`);
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ from: FROM_ADDRESS, to, subject, html }),
    });
    return res.ok;
  } catch (error) {
    console.error('Failed to send email:', error);
    return false;
  }
}

export function emailShell(title: string, body: string): string {
  return `<div style="font-family:system-ui;max-width:480px;margin:0 auto;padding:24px;">
    <h2 style="color:#1d4ed8;">Alpha-Life Engine</h2>
    <h3 style="color:#111827;">${title}</h3>
    ${body}
    <p style="color:#9ca3af;font-size:12px;margin-top:24px;">此邮件由 Alpha-Life Engine 自动发送</p>
  </div>`;
}

export function strategyExpiryEmailHtml(daysSince: number, lastEvolution: string): string {
  return emailShell('策略演化器已过期', `
    <p style="color:#374151;">您的策略参数已 <strong style="color:#dc2626;">${daysSince} 天</strong>未更新（上次演化：${lastEvolution.slice(0, 10)}）。</p>
    <p style="color:#374151;">过期的参数可能不再适应当前市场，系统已回退使用 LCH 年龄分配兜底。</p>
    <div style="padding:12px 16px;background:#eff6ff;border-radius:6px;color:#1d4ed8;font-family:monospace;">npm run evolve</div>
    <p style="color:#6b7280;font-size:14px;">请在本地运行策略演化器并上传最新报告。</p>
  `);
}

export interface ExecutionSuggestionParams {
  executedAmount: number;
  safeAmount: number;
  ambitionAmount: number;
  commission: number;
  nextSafeEtf: string;
  nextSafeEtfName: string;
  nextAmbitionEtf?: string;
  nextAmbitionEtfName?: string;
  message: string;
}

export function executionSuggestionEmailHtml(p: ExecutionSuggestionParams): string {
  return emailShell('执行建议：触发条件已满足', `
    <p style="color:#374151;">${p.message}</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;color:#374151;">
      <tr><td style="padding:6px 0;color:#6b7280;">建议执行金额</td><td style="text-align:right;font-weight:bold;">${formatCents(p.executedAmount)}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">安全层</td><td style="text-align:right;color:#16a34a;">${formatCents(p.safeAmount)}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">进取层</td><td style="text-align:right;color:#2563eb;">${formatCents(p.ambitionAmount)}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">预估佣金</td><td style="text-align:right;">${formatCents(p.commission)}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">安全层标的</td><td style="text-align:right;font-family:monospace;">${p.nextSafeEtf} ${p.nextSafeEtfName}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">进取层建议标的</td><td style="text-align:right;font-family:monospace;">${p.nextAmbitionEtfName ?? p.nextAmbitionEtf ?? '-'}</td></tr>
    </table>
    <p style="color:#6b7280;font-size:14px;">请在券商 App 中执行后，回到系统记录交易。</p>
  `);
}

export async function wasRecentlyNotified(
  db: D1Database,
  userId: number,
  type: NotificationType,
  withinDays: number
): Promise<boolean> {
  const cutoff = new Date(Date.now() - withinDays * 24 * 60 * 60 * 1000).toISOString();
  const row = await db.prepare(
    'SELECT id FROM notification_log WHERE user_id = ? AND notification_type = ? AND sent_at > ? LIMIT 1'
  ).bind(userId, type, cutoff).first<{ id: number }>();
  return row !== null;
}

export async function logNotification(db: D1Database, userId: number, type: NotificationType): Promise<void> {
  await db.prepare(
    'INSERT INTO notification_log (user_id, notification_type, sent_at) VALUES (?, ?, ?)'
  ).bind(userId, type, new Date().toISOString()).run();
}
