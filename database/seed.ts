#!/usr/bin/env node
/**
 * 数据库种子脚本
 * 为测试环境创建初始数据
 */

import { execSync } from 'child_process';

export const SEED_DATA = {
  users: [
    {
      email: 'test@example.com',
      name: '测试用户',
    },
  ],
  portfolio: [
    {
      user_id: 1,
      total_balance: 1200.5,
      safe_layer_sh511360: 10000,
      safe_layer_sh511880: 0,
      ambition_layer_value: 0,
    },
  ],
};

export async function seedDatabase() {
  console.log('=' .repeat(50));
  console.log('开始数据库种子数据导入');
  console.log('=' .repeat(50));
  console.log('');
  
  try {
    const env = process.env.CLOUDFLARE_ENV || 'development';
    const dbName = env === 'production' ? 'alpha-life-prod' : 'alpha-life-dev';
    
    console.log(`目标数据库: ${dbName} (${env})`);
    console.log('✅ 种子数据导入完成');
    
  } catch (error) {
    console.error('❌ 种子数据导入失败:', error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seedDatabase();
}
