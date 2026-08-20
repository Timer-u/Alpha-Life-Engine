import calendar from './trade-calendar.json';

const TRADING_DAYS = new Set<string>(calendar.dates);
const EARLIEST_TRADING_DAY = calendar.dates[0];
const THROUGH = calendar.through;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function asiaShanghaiDate(d: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Shanghai',
  }).formatToParts(d);
  const value = (type: string): string => parts.find(p => p.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isWeekend(date: string): boolean {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return weekday === 0 || weekday === 6;
}

export function isTradingDay(date: string): boolean {
  if (!ISO_DATE_RE.test(date)) throw new Error(`invalid date: ${date}`);
  if (isWeekend(date)) return false;
  if (date <= THROUGH) return TRADING_DAYS.has(date); // calendar stores trading days; holidays are absent
  return true; // beyond calendar -> weekday approximation
}

export function lastTradingDayOnOrBefore(date: string): string {
  if (date < EARLIEST_TRADING_DAY) {
    throw new Error(`invalid date: ${date} (earliest supported trading day is ${EARLIEST_TRADING_DAY})`);
  }
  let cursor = date;
  while (!isTradingDay(cursor)) cursor = shiftDate(cursor, -1);
  return cursor;
}

export function tradingDaysBetween(fromExclusive: string, toInclusive: string): string[] {
  const out: string[] = [];
  let cursor = toInclusive;
  while (cursor > fromExclusive) {
    if (isTradingDay(cursor)) out.push(cursor);
    cursor = shiftDate(cursor, -1);
  }
  return out.reverse();
}

export function detectMissingTradingDays(marks: Record<string, string>, today: string): string[] {
  const expectedLatest = lastTradingDayOnOrBefore(shiftDate(today, -1));
  const lines: string[] = [];
  for (const [symbol, mark] of Object.entries(marks)) {
    if (!mark || mark >= expectedLatest) continue;
    const missing = tradingDaysBetween(mark, expectedLatest);
    lines.push(`WARN ${symbol}: missing trading days ${missing.join(', ')} (last stored ${mark})`);
  }
  return lines;
}
