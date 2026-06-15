#!/usr/bin/env node
/**
 * 数据库迁移脚本
 * 在 D1 数据库中创建所需的表和索引
 */

import { execSync } from 'child_process';

export function runMigration() {
  console.log('=' .repeat(50));
  console.log('开始数据库迁移');
  console.log('=' .repeat(50));
  console.log('');
  
  try {
    const args = process.argv.slice(2);
    const envArgIndex = args.findIndex(arg => arg === '--env' || arg === '-e');
    const env = envArgIndex >= 0 && args[envArgIndex + 1]
      ? args[envArgIndex + 1]
      : process.env.CLOUDFLARE_ENV || 'development';
    const dbName = env === 'production' ? 'alpha-life-prod' : 'alpha-life-dev';
    
    console.log(`目标数据库: ${dbName} (${env})`);
    console.log('执行 SQL 创建表...');
    console.log('');
    
    // 使用 wrangler d1 execute 执行 SQL
    const cmd = `wrangler d1 execute ${dbName} --file=./database/schema.sql --env ${env}`;
    console.log(`命令: ${cmd}`);
    console.log('');
    
    execSync(cmd, {
      stdio: 'inherit',
      cwd: process.cwd()
    });
    
    console.log('');
    console.log('=' .repeat(50));
    console.log('✅ 数据库迁移完成');
    console.log('=' .repeat(50));
    
  } catch (error) {
    console.error('❌ 迁移失败:', error);
    process.exit(1);
  }
}

// If this file is run directly, execute the migration
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigration();
}
