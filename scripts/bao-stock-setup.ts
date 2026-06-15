#!/usr/bin/env node

import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);

interface BaoStockConfig {
  codes: Array<{ code: string; name: string }>;
  startDate: string;
  endDate: string;
  outputDir: string;
}

export async function baoStockSetup() {
  console.log('='.repeat(50));
  console.log('BaoStock 历史数据初始化');
  console.log('='.repeat(50));
  console.log('');

  const config: BaoStockConfig = {
    codes: [
      { code: 'sh.511360', name: '海富通短融' },
      { code: 'sh.511880', name: '银华日利' },
    ],
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
    console.log(`   ETF 代码: ${config.codes.map(c => c.code).join(', ')}`);
    console.log('');
    console.log('💡 提示：首次下载可能需要 10-30 分钟，请耐心等待...');
    console.log('');

    try {
      const { stdout, stderr } = await execAsync(`python "${scriptPath}"`);
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
    } catch (firstError: any) {
      try {
        const { stdout, stderr } = await execAsync(`python3 "${scriptPath}"`);
        if (stdout) process.stdout.write(stdout);
        if (stderr) process.stderr.write(stderr);
      } catch (secondError: any) {
        console.error('❌ Python 执行失败');
        console.error('   请确保已安装 Python 3.8+');
        console.error('   并安装了 baostock 包: pip install baostock pandas');
        throw secondError;
      }
    }

    console.log('');
    console.log('='.repeat(50));
    console.log('✅ BaoStock 初始化完成');
    console.log('='.repeat(50));
    console.log('');
    console.log('下一步操作：');
    console.log('1. 验证 CSV 文件已生成在 data/market_data/ 目录');
    console.log('2. 运行 npm run database:migrate 将数据导入 D1');
    console.log('3. 配置 GitHub Actions 用于日常自动更新');
    console.log('');
  } catch (error) {
    console.error('❌ BaoStock 初始化失败:', error);
    process.exit(1);
  }
}

function createPythonScript(config: BaoStockConfig): string {
  return `#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
BaoStock 历史数据下载脚本
自动下载指定 ETF 的历史价格数据
"""

import baostock as bs
import pandas as pd
import sys
import os
from datetime import datetime

class BaoStockDownloader:
    def __init__(self, output_dir: str):
        self.output_dir = output_dir
        self.codes = [
            ('sh.511360', '海富通短融'),
            ('sh.511880', '银华日利'),
        ]
        self.start_date = '1990-01-01'
        self.end_date = datetime.now().strftime('%Y-%m-%d')
    
    def login(self):
        """登录 BaoStock"""
        try:
            lg = bs.login()
            if lg.error_code == '0':
                print(f"✅ BaoStock 登录成功")
                return True
            else:
                print(f"❌ 登录失败: {lg.msg}")
                return False
        except Exception as e:
            print(f"❌ 登录异常: {e}")
            return False
    
    def download_k_data(self, code: str, name: str):
        """下载 K 线数据"""
        print(f"\n📥 开始下载 {name} ({code})")
        print(f"   时间范围: {self.start_date} 到 {self.end_date}")
        
        try:
            rs = bs.query_history_k_data_plus(
                code,
                'date,code,open,high,low,close,volume,amount',
                start_date=self.start_date,
                end_date=self.end_date,
                frequency='d'
            )
            
            if rs.error_code != '0':
                print(f"❌ 查询失败: {rs.msg}")
                return None
            
            data = []
            count = 0
            
            while rs.error_code == '0':
                row = rs.next()
                if row is None:
                    break
                
                try:
                    record = {
                        'date': row[0],
                        'code': row[1],
                        'open': float(row[2]) if row[2] else None,
                        'high': float(row[3]) if row[3] else None,
                        'low': float(row[4]) if row[4] else None,
                        'close': float(row[5]) if row[5] else None,
                        'volume': int(row[6]) if row[6] else 0,
                        'amount': float(row[7]) if row[7] else 0,
                    }
                    data.append(record)
                    count += 1
                    
                    if count % 1000 == 0:
                        print(f"   已下载: {count} 条 ({row[0]})")
                except (ValueError, IndexError) as e:
                    print(f"   ⚠️  跳过无效数据: {e}")
                    continue
            
            if data:
                df = pd.DataFrame(data)
                filename = f"{code.replace('.', '_')}.csv"
                filepath = os.path.join(self.output_dir, filename)
                df.to_csv(filepath, index=False)
                print(f"✅ 已保存 {count} 条记录到: {filename}")
                return data
            else:
                print(f"❌ 未获取到数据")
                return None
                
        except Exception as e:
            print(f"❌ 下载异常: {e}")
            return None
    
    def run(self):
        """执行下载"""
        if not self.login():
            return False
        
        try:
            total_records = 0
            for code, name in self.codes:
                data = self.download_k_data(code, name)
                if data:
                    total_records += len(data)
            
            print(f"\n✅ 下载完成: 共 {len(self.codes)} 个 ETF，{total_records} 条记录")
            return True
            
        finally:
            bs.logout()
            print("✅ BaoStock 登出")

if __name__ == '__main__':
    downloader = BaoStockDownloader('${config.outputDir}')
    success = downloader.run()
    sys.exit(0 if success else 1)
`;
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  baoStockSetup().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
