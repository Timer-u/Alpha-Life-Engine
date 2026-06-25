#!/usr/bin/env node
/**
 * 数据库种子脚本
 */

import { execSync } from 'child_process';

export async function seedDatabase() {
  console.log('='.repeat(50));
  console.log('开始数据库种子数据导入');
  console.log('='.repeat(50));

  try {
    const env = process.env.CLOUDFLARE_ENV ?? 'development';
    const dbName = env === 'production' ? 'alpha-life-prod' : 'alpha-life-dev';

    console.log(`目标数据库: ${dbName} (${env})`);

    const seedSql = `
      INSERT OR IGNORE INTO email_whitelist (email, notes) VALUES
      ('test@example.com', '测试用户'),
      ('admin@alpha-life.yourdomain.com', '管理员');
    `;

    const cmd = `wrangler d1 execute ${dbName} --command="${seedSql.replace(/\n/g, ' ')}" ${env === 'development' ? '--local' : '--remote'}`;

    execSync(cmd, { stdio: 'inherit', cwd: process.cwd() });

    console.log('');
    console.log('✅ 种子数据导入完成');

  } catch (error) {
    console.error('❌ 种子数据导入失败:', error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void seedDatabase();
}
