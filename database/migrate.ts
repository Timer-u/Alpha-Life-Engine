#!/usr/bin/env node
/**
 * 数据库迁移脚本
 */

import { execSync } from 'child_process';

export function runMigration() {
  console.log('='.repeat(50));
  console.log('开始数据库迁移');
  console.log('='.repeat(50));

  try {
    const args = process.argv.slice(2);
    const envArgIndex = args.findIndex(arg => arg === '--env' || arg === '-e');
    const env = envArgIndex >= 0 && args[envArgIndex + 1]
      ? args[envArgIndex + 1]
       : process.env.CLOUDFLARE_ENV ?? 'development';
    const dbName = env === 'production' ? 'alpha-life-prod' : 'alpha-life-dev';

    console.log(`目标数据库: ${dbName} (${env})`);

    const cmd = `wrangler d1 execute ${dbName} --file=./database/schema.sql ${env === 'development' ? '--local' : '--remote'}`;
    console.log(`命令: ${cmd}`);

    execSync(cmd, { stdio: 'inherit', cwd: process.cwd() });

    console.log('');
    console.log('='.repeat(50));
    console.log('✅ 数据库迁移完成');
    console.log('='.repeat(50));

  } catch (error) {
    console.error('❌ 迁移失败:', error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigration();
}
