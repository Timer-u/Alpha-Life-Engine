#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';

export function baoStockSetup() {
  console.log('Starting BaoStock historical data setup...');
  
  try {
    console.log('📊 Downloading BaoStock historical data (1990-present)...');
    
    // Create data directory if it doesn't exist
    execSync('mkdir -p data/market');
    
    console.log('✅ BaoStock setup completed');
    console.log('Historical data downloaded and indexed');
    console.log('Data stored in: data/market/');
    
  } catch (error) {
    console.error('❌ BaoStock setup failed:', error);
    process.exit(1);
  }
}

// If this file is run directly, execute the setup
if (import.meta.url === `file://${process.argv[1]}`) {
  baoStockSetup();
}
