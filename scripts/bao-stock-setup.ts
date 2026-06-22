#!/usr/bin/env node

import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

interface BaoStockConfig {
  codes: Array<{ code: string; name: string }>;
  startDate: string;
  endDate: string;
  outputDir: string;
}

// 跟踪的 ETF 列表：安全层 + 进取层
const TRACKED_ETFS = [
  { code: 'sh.511360', name: '海富通短融ETF', layer: 'safe' },
  { code: 'sh.511880', name: '银华日利', layer: 'safe' },
  { code: 'sh.510300', name: '沪深300ETF', layer: 'ambition' },
  { code: 'sh.510500', name: '中证500ETF', layer: 'ambition' },
  { code: 'sh.515080', name: '招商中证红利ETF', layer: 'ambition' },
];

export async function baoStockSetup() {
  console.log('='.repeat(50));
  console.log('BaoStock 历史数据初始化');
  console.log('='.repeat(50));
  console.log('');

  const config: BaoStockConfig = {
    codes: TRACKED_ETFS,
    startDate: '1990-01-01',
    endDate: new Date().toISOString().split('T')[0],
    outputDir: resolve(process.cwd(), 'data/market_data'),
  };

  try {
    mkdirSync(config.outputDir, { recursive: true });
    console.log(`✅ 数据目录已创建: ${config.outputDir}`);
    console.log('');

    const pythonScript = createPythonScript(config);
    const scriptPath = resolve(config.outputDir, 'download.py');
    writeFileSync(scriptPath, pythonScript, 'utf8');
    console.log(`✅ Python 脚本已创建: ${scriptPath}`);
    console.log('');

    console.log('📥 开始下载历史数据...');
    console.log(`   时间范围: ${config.startDate} 到 ${config.endDate}`);
    console.log(`   ETF: ${config.codes.map(c => `${c.code}(${c.name})`).join(', ')}`);
    console.log('');
    console.log('💡 提示：首次下载可能需要 10-30 分钟');
    console.log('');

    try {
      execSync(`python "${scriptPath}"`, { stdio: 'inherit' });
    } catch {
      execSync(`python3 "${scriptPath}"`, { stdio: 'inherit' });
    }

    // 生成 SQL 导入文件
    generateImportSql(config);

    console.log('');
    console.log('='.repeat(50));
    console.log('✅ BaoStock 初始化完成');
    console.log('='.repeat(50));
    console.log('');
    console.log('下一步操作：');
    console.log('1. 运行 npm run database:migrate 将数据导入 D1');
    console.log('2. 或运行 npm run database:import-market 直接导入市场数据');
    console.log('3. 配置 GitHub Actions 用于日常自动更新');
    console.log('');
  } catch (error) {
    console.error('❌ BaoStock 初始化失败:', error);
    process.exit(1);
  }
}

function generateImportSql(config: BaoStockConfig): void {
  console.log('\n📄 生成 SQL 导入文件...');
  const sqlPath = resolve(config.outputDir, 'import_market_data.sql');
  const lines: string[] = [
    '-- Alpha-Life Engine Market Data Import',
    `-- Generated: ${new Date().toISOString()}`,
    '',
  ];

  for (const etf of config.codes) {
    const csvFile = resolve(config.outputDir, `${etf.code.replace('.', '_')}.csv`);
    try {
      const csv = readFileSync(csvFile, 'utf8');
      const rows = csv.split('\n').slice(1).filter(r => r.trim());
      let count = 0;
      for (const row of rows) {
        const cols = row.split(',');
        if (cols.length < 6) continue;
        const [date, code, open, high, low, close, volume, amount] = cols.map(c => c.trim());
        if (!date || !close) continue;
        const symbol = etf.code.replace('sh.', '');
        lines.push(
          `INSERT OR IGNORE INTO market_data (symbol, date, open, high, low, close, volume) VALUES ('${symbol}', '${date}', ${open || 'NULL'}, ${high || 'NULL'}, ${low || 'NULL'}, ${close || 'NULL'}, ${volume || '0'});`
        );
        count++;
      }
      console.log(`   ${etf.name} (${etf.code}): ${count} 条记录`);
    } catch {
      console.log(`   ⚠️  ${etf.name}: 未找到 CSV 文件，跳过`);
    }
  }

  writeFileSync(sqlPath, lines.join('\n'), 'utf8');
  console.log(`✅ SQL 导入文件已生成: ${sqlPath}`);
}

function createPythonScript(config: BaoStockConfig): string {
  const codesJson = JSON.stringify(config.codes.map(c => [c.code, c.name]));
  return `#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
BaoStock 历史数据下载 + 每日更新脚本
"""

import baostock as bs
import pandas as pd
import sys
import os
from datetime import datetime, timedelta

class BaoStockDownloader:
    def __init__(self, output_dir: str):
        self.output_dir = output_dir
        self.codes = ${codesJson}
        self.start_date = '1990-01-01'
        self.end_date = datetime.now().strftime('%Y-%m-%d')

    def login(self):
        try:
            lg = bs.login()
            if lg.error_code == '0':
                print(f"[OK] BaoStock 登录成功")
                return True
            else:
                print(f"[FAIL] 登录失败: {lg.msg}")
                return False
        except Exception as e:
            print(f"[FAIL] 登录异常: {e}")
            return False

    def download_k_data(self, code: str, name: str, start_date: str = None):
        print(f"  -> {name} ({code})")
        try:
            rs = bs.query_history_k_data_plus(
                code,
                'date,code,open,high,low,close,volume,amount',
                start_date=start_date or self.start_date,
                end_date=self.end_date,
                frequency='d'
            )
            if rs.error_code != '0':
                print(f"     [FAIL] {rs.msg}")
                return None
            data = []
            while True:
                row = rs.next()
                if row is None:
                    break
                try:
                    data.append({
                        'date': row[0],
                        'code': row[1],
                        'open': float(row[2]) if row[2] else None,
                        'high': float(row[3]) if row[3] else None,
                        'low': float(row[4]) if row[4] else None,
                        'close': float(row[5]) if row[5] else None,
                        'volume': int(row[6]) if row[6] else 0,
                        'amount': float(row[7]) if row[7] else 0,
                    })
                except (ValueError, IndexError):
                    continue
            if data:
                df = pd.DataFrame(data)
                filename = f"{code.replace('.', '_')}.csv"
                filepath = os.path.join(self.output_dir, filename)
                df.to_csv(filepath, index=False)
                print(f"     [OK] {len(data)} 条记录")
                return data
            else:
                print(f"     [SKIP] 无数据")
                return None
        except Exception as e:
            print(f"     [FAIL] {e}")
            return None

    def download_all_history(self):
        if not self.login():
            return False
        try:
            total = 0
            for code, name in self.codes:
                data = self.download_k_data(code, name)
                if data:
                    total += len(data)
            print(f"\\n[OK] 全部完成: {len(self.codes)} 个 ETF, {total} 条记录")
            return True
        finally:
            bs.logout()

    def download_latest(self, days_back: int = 5):
        """仅下载最近 N 个交易日的数据（用于每日更新）"""
        if not self.login():
            return False
        try:
            start = (datetime.now() - timedelta(days=days_back)).strftime('%Y-%m-%d')
            print(f"[INFO] 获取最近 {days_back} 天数据 (自 {start})")
            total = 0
            for code, name in self.codes:
                data = self.download_k_data(code, name, start_date=start)
                if data:
                    total += len(data)
            print(f"\\n[OK] 每日更新完成: {total} 条新记录")
            return True
        finally:
            bs.logout()

if __name__ == '__main__':
    import sys
    mode = sys.argv[1] if len(sys.argv) > 1 else 'full'
    downloader = BaoStockDownloader('${config.outputDir}')
    if mode == 'daily':
        success = downloader.download_latest()
    else:
        success = downloader.download_all_history()
    sys.exit(0 if success else 1)
`;
}

// 当直接运行时执行
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  baoStockSetup().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
