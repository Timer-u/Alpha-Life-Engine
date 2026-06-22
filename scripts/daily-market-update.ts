#!/usr/bin/env node
/**
 * 每日市场数据更新脚本
 * 
 * 功能：
 * 1. 通过 BaoStock (Python) 获取最近5个交易日 ETF 行情
 * 2. 生成 INSERT OR IGNORE SQL
 * 3. 通过 wrangler d1 execute 写入 Cloudflare D1
 * 
 * 使用方式：
 *   npm run market:update             # 开发环境 (--local)
 *   npm run market:update -- --prod   # 生产环境 (--remote)
 *
 * 依赖：
 *   - Python 3.8+ + baostock + pandas
 *   - wrangler CLI (已配置 D1 绑定)
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);

// 跟踪的 ETF 列表（与 baoStock-setup.ts 保持一致）
const TRACKED_ETFS = [
  { code: 'sh.511360', name: '海富通短融ETF', layer: 'safe' },
  { code: 'sh.511880', name: '银华日利', layer: 'safe' },
  { code: 'sh.510300', name: '沪深300ETF', layer: 'ambition' },
  { code: 'sh.510500', name: '中证500ETF', layer: 'ambition' },
  { code: 'sh.515080', name: '招商中证红利ETF', layer: 'ambition' },
];

/** 解析命令行参数 */
function parseArgs(): { env: 'development' | 'production'; dbName: string } {
  const args = process.argv.slice(2);
  const isProd = args.includes('--prod') || args.includes('--production') || args.includes('-p');

  return {
    env: isProd ? 'production' : 'development',
    dbName: isProd ? 'alpha-life-prod' : 'alpha-life-dev',
  };
}

/** 生成 Python 内联脚本用于获取最新数据 */
function createPythonScript(outputDir: string): string {
  const codesJson = JSON.stringify(TRACKED_ETFS.map(c => [c.code, c.name]));
  return `
import baostock as bs, pandas as pd, sys, os, json
from datetime import datetime, timedelta

codes = ${codesJson}
out_dir = "${outputDir.replace(/\\/g, '\\\\')}"
start = (datetime.now() - timedelta(days=10)).strftime('%Y-%m-%d')
end = datetime.now().strftime('%Y-%m-%d')

lg = bs.login()
if lg.error_code != '0':
    print(json.dumps({"error": lg.msg}))
    sys.exit(1)

results = []
for code, name in codes:
    rs = bs.query_history_k_data_plus(
        code, 'date,code,open,high,low,close,volume,amount',
        start_date=start, end_date=end, frequency='d'
    )
    rows = []
    while True:
        r = rs.next()
        if r is None: break
        try:
            rows.append({
                "symbol": r[1].replace("sh.", "").replace("sz.", ""),
                "date": r[0],
                "open": float(r[2]) if r[2] else None,
                "high": float(r[3]) if r[3] else None,
                "low": float(r[4]) if r[4] else None,
                "close": float(r[5]) if r[5] else None,
                "volume": int(r[6]) if r[6] else 0,
            })
        except: continue
    results.extend(rows)

bs.logout()

# 保存 CSV
df = pd.DataFrame(results)
for code, name in codes:
    sym = code.replace("sh.", "").replace("sz.", "")
    sub = df[df["symbol"] == sym]
    if not sub.empty:
        fname = os.path.join(out_dir, f"{code.replace('.', '_')}.csv")
        sub.to_csv(fname, index=False)

# 输出供 Node.js 解析的 JSON
print(json.dumps({"count": len(results), "symbols": list(set(r["symbol"] for r in results))}))
`;
}

/** 生成 SQL 插入语句 */
function generateInsertSql(data: Array<{
  symbol: string; date: string; open: number | null;
  high: number | null; low: number | null; close: number | null; volume: number;
}>): string {
  const lines: string[] = [
    '-- Alpha-Life Engine Daily Market Data Update',
    `-- Generated: ${new Date().toISOString()}`,
    '',
  ];
  for (const row of data) {
    lines.push(
      `INSERT OR IGNORE INTO market_data (symbol, date, open, high, low, close, volume) VALUES (` +
      `'${row.symbol}', '${row.date}', ` +
      `${row.open ?? 'NULL'}, ${row.high ?? 'NULL'}, ${row.low ?? 'NULL'}, ${row.close ?? 'NULL'}, ${row.volume ?? 0}` +
      `);`
    );
  }
  return lines.join('\n');
}

/** 执行 Python 脚本并获取数据 */
function fetchDataViaPython(outputDir: string): Array<{
  symbol: string; date: string; open: number | null;
  high: number | null; low: number | null; close: number | null; volume: number;
}> {
  const pyScript = createPythonScript(outputDir);
  const pyFile = resolve(outputDir, 'daily_update.py');
  writeFileSync(pyFile, pyScript, 'utf8');

  console.log('  🐍 正在通过 BaoStock 获取最新行情...');

  let stdout: string;
  try {
    stdout = execSync(`python "${pyFile}"`, { encoding: 'utf8', timeout: 120000 });
  } catch {
    stdout = execSync(`python3 "${pyFile}"`, { encoding: 'utf8', timeout: 120000 });
  }

  // 提取最后一行 JSON 输出
  const lines = stdout.trim().split('\n');
  const lastLine = lines[lines.length - 1];
  const parsed = JSON.parse(lastLine);

  if (parsed.error) {
    throw new Error(`BaoStock 错误: ${parsed.error}`);
  }

  // 从 CSVs 重新读取数据
  const allData: Array<{
    symbol: string; date: string; open: number | null;
    high: number | null; low: number | null; close: number | null; volume: number;
  }> = [];

  for (const etf of TRACKED_ETFS) {
    const sym = etf.code.replace('sh.', '').replace('sz.', '');
    const csvFile = resolve(outputDir, `${etf.code.replace('.', '_')}.csv`);
    if (!existsSync(csvFile)) continue;

    const csv = execSync(`type "${csvFile}"`, { encoding: 'utf8', shell: 'cmd.exe' });
    const rows = csv.split('\n').slice(1).filter(r => r.trim());
    for (const row of rows) {
      const cols = row.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
      if (cols.length < 6) continue;
      const [date, code, open, high, low, close, volume] = cols;
      if (!date || !close) continue;
      allData.push({
        symbol: code.replace('sh.', '').replace('sz.', ''),
        date,
        open: open ? parseFloat(open) : null,
        high: high ? parseFloat(high) : null,
        low: low ? parseFloat(low) : null,
        close: parseFloat(close),
        volume: volume ? parseInt(volume, 10) : 0,
      });
    }
  }

  console.log(`     ✅ 获取 ${parsed.count} 条数据`);

  // 去重（按 symbol + date）
  const seen = new Set<string>();
  return allData.filter(row => {
    const key = `${row.symbol}|${row.date}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 执行 wrangler d1 execute 导入数据 */
function importToD1(sqlPath: string, env: 'development' | 'production', dbName: string): void {
  const isLocal = env === 'development';
  const flag = isLocal ? '--local' : '--remote';
  const cmd = `wrangler d1 execute ${dbName} --file="${sqlPath}" ${flag}`;
  console.log(`  ⚡ 正在写入 ${dbName} (${env})...`);
  execSync(cmd, { stdio: 'inherit', cwd: process.cwd(), timeout: 300000 });
}

// ============================================================
// Main
// ============================================================
export async function dailyMarketUpdate(): Promise<void> {
  console.log('');
  console.log('='.repeat(50));
  console.log('📊 Alpha-Life 每日市场数据更新');
  console.log('='.repeat(50));
  console.log('');

  const { env, dbName } = parseArgs();
  const outputDir = resolve(process.cwd(), 'data/market_data');
  mkdirSync(outputDir, { recursive: true });

  const startTime = Date.now();

  try {
    // Step 1: Fetch data from BaoStock
    console.log('📥 Step 1: 获取 BaoStock 行情数据');
    const data = fetchDataViaPython(outputDir);
    if (data.length === 0) {
      console.log('   ⚠️  无新数据，跳过更新');
      console.log('');
      console.log('='.repeat(50));
      console.log('✅ 更新完成 (无变更)');
      return;
    }
    console.log('');

    // Step 2: Generate SQL
    console.log('📄 Step 2: 生成 SQL 语句');
    const sql = generateInsertSql(data);
    const sqlPath = resolve(outputDir, `update_${new Date().toISOString().split('T')[0]}.sql`);
    writeFileSync(sqlPath, sql, 'utf8');
    console.log(`     ✅ SQL 文件: ${sqlPath}`);
    const insertCount = sql.split('\n').filter(l => l.startsWith('INSERT')).length;
    console.log(`     📝 ${insertCount} 条 INSERT`);
    console.log('');

    // Step 3: Import to D1 via wrangler
    console.log('🗄️  Step 3: 导入 Cloudflare D1');
    importToD1(sqlPath, env, dbName);
    console.log('');

    // Done
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('='.repeat(50));
    console.log(`✅ 每日市场数据更新完成 (${elapsed}s)`);
    console.log(`   数据库: ${dbName} (${env})`);
    console.log(`   新增记录: ${insertCount}`);
    console.log('='.repeat(50));
  } catch (error) {
    console.error('');
    console.error('❌ 更新失败:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// 当直接运行时
if (process.argv[1] === __filename) {
  dailyMarketUpdate().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
