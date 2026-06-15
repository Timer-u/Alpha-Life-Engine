import {
  User,
  Portfolio,
  Position,
  Transaction,
  MarketData,
  TriggerDecision,
  SystemConfig,
  StrategyReport,
  TransactionForm,
} from './types';

/**
 * Database Operations for Alpha-Life Engine
 * 
 * Handles all CRUD operations and database queries
 */
export class Database {
  // This would be initialized with Cloudflare D1 connection
  private db: any; // Placeholder for actual D1 connection

  constructor(dbConnection: any) {
    this.db = dbConnection;
  }

  // User Operations
  async createUser(email: string): Promise<User> {
    const query = `
      INSERT INTO users (email, created_at, email_verified, created_by)
      VALUES (?, ?, ?, ?)
      RETURNING *
    `;
    const params = [email, new Date().toISOString(), false, 'cloudflare-access'];
    
    const result = await this.db.prepare(query).bind(...params).all();
    return result.results[0];
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const query = 'SELECT * FROM users WHERE email = ?';
    const result = await this.db.prepare(query).bind(email).all();
    return result.results[0] || null;
  }

  async updateSessionToken(email: string, sessionToken: string, expires: string): Promise<boolean> {
    const query = `
      UPDATE users 
      SET session_token = ?, session_expires = ?, last_login = ?
      WHERE email = ?
    `;
    const params = [sessionToken, expires, new Date().toISOString(), email];
    
    const result = await this.db.prepare(query).bind(...params).run();
    return result.success;
  }

  // Portfolio Operations
  async getPortfolio(userId: number): Promise<Portfolio | null> {
    const query = 'SELECT * FROM portfolio WHERE user_id = ?';
    const result = await this.db.prepare(query).bind(userId).all();
    return result.results[0] || null;
  }

  async updatePortfolio(userId: number, updates: Partial<Portfolio>): Promise<boolean> {
    const fields = Object.keys(updates).filter(key => key !== 'user_id').map(key => `${key} = ?`);
    const values = Object.values(updates).filter((_, index) => Object.keys(updates)[index] !== 'user_id');
    
    const query = `
      UPDATE portfolio 
      SET ${fields.join(', ')}, updated_at = ?
      WHERE user_id = ?
    `;
    
    const params = [...values, new Date().toISOString(), userId];
    const result = await this.db.prepare(query).bind(...params).run();
    return result.success;
  }

  async createPortfolio(userId: number): Promise<Portfolio> {
    const query = `
      INSERT INTO portfolio (user_id, total_balance, safe_layer_balance, ambition_layer_balance, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      RETURNING *
    `;
    const params = [userId, 0, 0, 0, new Date().toISOString(), new Date().toISOString()];
    
    const result = await this.db.prepare(query).bind(...params).all();
    return result.results[0];
  }

  // Position Operations
  async getPositions(userId: number): Promise<Position[]> {
    const query = 'SELECT * FROM positions WHERE user_id = ? ORDER BY created_at DESC';
    const result = await this.db.prepare(query).bind(userId).all();
    return result.results;
  }

  async getPosition(userId: number, symbol: string, layer: 'safe' | 'ambition'): Promise<Position | null> {
    const query = 'SELECT * FROM positions WHERE user_id = ? AND symbol = ? AND layer = ?';
    const result = await this.db.prepare(query).bind(userId, symbol, layer).all();
    return result.results[0] || null;
  }

  async updatePosition(userId: number, symbol: string, layer: 'safe' | 'ambition', updates: Partial<Position>): Promise<boolean> {
    const fields = Object.keys(updates).map(key => `${key} = ?`);
    const values = Object.values(updates);
    
    const query = `
      UPDATE positions 
      SET ${fields.join(', ')}, updated_at = ?
      WHERE user_id = ? AND symbol = ? AND layer = ?
    `;
    
    const params = [...values, new Date().toISOString(), userId, symbol, layer];
    const result = await this.db.prepare(query).bind(...params).run();
    return result.success;
  }

  async createPosition(position: Omit<Position, 'id' | 'created_at' | 'updated_at'>): Promise<Position> {
    const query = `
      INSERT INTO positions (user_id, symbol, name, shares, avg_price, current_price, market_value, layer, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `;
    const params = [
      position.user_id,
      position.symbol,
      position.name,
      position.shares,
      position.avg_price,
      position.current_price,
      position.market_value,
      position.layer,
      new Date().toISOString(),
      new Date().toISOString(),
    ];
    
    const result = await this.db.prepare(query).bind(...params).all();
    return result.results[0];
  }

  // Transaction Operations
  async getTransactions(userId: number, limit: number = 100): Promise<Transaction[]> {
    const query = 'SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?';
    const result = await this.db.prepare(query).bind(userId, limit).all();
    return result.results;
  }

  async createTransaction(transaction: Omit<Transaction, 'id' | 'created_at'>): Promise<Transaction> {
    const query = `
      INSERT INTO transactions (user_id, symbol, shares, price, amount, commission, transaction_type, trigger_signal, layer, created_at, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `;
    const params = [
      transaction.user_id,
      transaction.symbol,
      transaction.shares,
      transaction.price,
      transaction.amount,
      transaction.commission,
      transaction.transaction_type,
      transaction.trigger_signal,
      transaction.layer,
      new Date().toISOString(),
      transaction.notes,
    ];
    
    const result = await this.db.prepare(query).bind(...params).all();
    return result.results[0];
  }

  async recordManualTransaction(userId: number, form: TransactionForm): Promise<Transaction> {
    const amount = form.amount !== undefined ? form.amount : form.shares * form.price;
    const commission = this.calculateCommission(amount);

    const transaction = {
      user_id: userId,
      symbol: form.symbol,
      shares: form.shares,
      price: form.price,
      amount,
      commission,
      transaction_type: form.transaction_type,
      trigger_signal: form.trigger_signal,
      layer: form.layer,
      notes: form.notes,
    };
    
    return await this.createTransaction(transaction);
  }

  // Trigger Log Operations
  async logTriggerDecision(userId: number, balance: number, decision: TriggerDecision, signalValue: number, executedAmount: number, commission: number): Promise<void> {
    const query = `
      INSERT INTO trigger_log (user_id, balance, trigger_decision, signal_value, executed_amount, commission, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;
    const params = [userId, balance, decision, signalValue, executedAmount, commission, new Date().toISOString()];
    
    await this.db.prepare(query).bind(...params).run();
  }

  // Market Data Operations
  async getMarketData(symbol: string, startDate: string, endDate: string): Promise<MarketData[]> {
    const query = 'SELECT * FROM market_data WHERE symbol = ? AND date BETWEEN ? AND ? ORDER BY date';
    const result = await this.db.prepare(query).bind(symbol, startDate, endDate).all();
    return result.results;
  }

  async getLatestMarketData(symbol: string): Promise<MarketData | null> {
    const query = 'SELECT * FROM market_data WHERE symbol = ? ORDER BY date DESC LIMIT 1';
    const result = await this.db.prepare(query).bind(symbol).all();
    return result.results[0] || null;
  }

  // System Configuration
  async getConfig(key: string): Promise<SystemConfig | null> {
    const query = 'SELECT * FROM config WHERE key = ?';
    const result = await this.db.prepare(query).bind(key).all();
    const config = result.results[0];
    
    if (!config) return null;
    
    return JSON.parse(config.value);
  }

  async getAllConfigs(): Promise<SystemConfig> {
    const query = 'SELECT * FROM config';
    const result = await this.db.prepare(query).all();
    
    const config: SystemConfig = {
      trigger_line: 1667,
      commission_rate: 0.0003,
      commission_min: 5,
      safe_layer_primary: '511360',
      safe_layer_backup: '511880',
      safe_layer_name_primary: '海富通短融ETF',
      safe_layer_name_backup: '银华日利',
      ambition_layer_name: '权益ETF',
    };
    
    result.results.forEach((row: any) => {
      try {
        const configValue = JSON.parse(row.value);
        Object.assign(config, configValue);
      } catch (e) {
        console.warn('Failed to parse config value:', row.key, e);
      }
    });
    
    return config;
  }

  // Strategy Reports
  async getLatestStrategyReport(userId: number): Promise<StrategyReport | null> {
    const query = 'SELECT * FROM strategy_reports WHERE user_id = ? ORDER BY created_at DESC LIMIT 1';
    const result = await this.db.prepare(query).bind(userId).all();
    return result.results[0] || null;
  }

  async saveStrategyReport(userId: number, report: Omit<StrategyReport, 'id' | 'created_at'>): Promise<StrategyReport> {
    const query = `
      INSERT INTO strategy_reports (user_id, report_data, pbo_score, dsr_ranking, parameter_count, evolution_timestamp, next_scheduled_evolution, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `;
    const params = [
      userId,
      report.report_data,
      report.pbo_score,
      report.dsr_ranking,
      report.parameter_count,
      report.evolution_timestamp,
      report.next_scheduled_evolution,
      new Date().toISOString(),
    ];
    
    const result = await this.db.prepare(query).bind(...params).all();
    return result.results[0];
  }

  // Helper methods
  private calculateCommission(amount: number): number {
    const commission = amount * 0.0003; // 0.03%
    return Math.max(commission, 5); // Minimum 5 yuan
  }

  // Portfolio summary for dashboard
  async getPortfolioSummary(userId: number): Promise<any> {
    const query = 'SELECT * FROM portfolio_summary WHERE user_id = ?';
    const result = await this.db.prepare(query).bind(userId).all();
    return result.results[0] || null;
  }

  // Recent transactions for dashboard
  async getRecentTransactions(userId: number, limit: number = 10): Promise<Transaction[]> {
    const query = `
      SELECT * FROM recent_transactions 
      WHERE user_id = ? 
      ORDER BY created_at DESC 
      LIMIT ?
    `;
    const result = await this.db.prepare(query).bind(userId, limit).all();
    return result.results;
  }
}

// Export database instance (to be initialized with Cloudflare D1 connection)
export const db = new Database(null); // Will be properly initialized later
