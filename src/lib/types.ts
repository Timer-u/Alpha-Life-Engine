// Alpha-Life Engine API Type Contracts

// User and Authentication Types
export interface User {
  id: number;
  email: string;
  created_at: string;
  last_login?: string;
  session_token?: string;
  session_expires?: string;
  email_verified: boolean;
  created_by: string;
}

// Portfolio Types
export interface Portfolio {
  id: number;
  user_id: number;
  total_balance: number;
  safe_layer_balance: number;
  ambition_layer_balance: number;
  last_balance_update: string;
  created_at: string;
  updated_at: string;
}

// Position Types
export interface Position {
  id: number;
  user_id: number;
  symbol: string;
  name: string;
  shares: number;
  avg_price: number;
  current_price: number;
  market_value: number;
  last_price_update: string;
  layer: 'safe' | 'ambition';
  created_at: string;
  updated_at: string;
}

// Transaction Types
export interface Transaction {
  id: number;
  user_id: number;
  symbol: string;
  shares: number;
  price: number;
  amount: number;
  commission: number;
  transaction_type: 'buy' | 'sell';
  trigger_signal?: string;
  layer: 'safe' | 'ambition';
  created_at: string;
  notes?: string;
}

// Market Data Types
export interface MarketData {
  id: number;
  symbol: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  created_at: string;
}

// Trigger Decision Types
export type TriggerDecision = 'DEFER' | 'SKIP' | 'EXECUTE';
export type SignalType = 'BSM' | 'DOUBLE' | 'NORMAL' | 'SKIP';
export type LayerType = 'safe' | 'ambition';

export interface TriggerInput {
  user_id: number;
  current_balance: number;
  signal_value: number;
  signal_type: SignalType;
  current_time: string;
}

export interface TriggerResponse {
  decision: TriggerDecision;
  executed_amount?: number;
  commission: number;
  layer_allocation: {
    safe_amount: number;
    ambition_amount: number;
  };
  message: string;
  next_safe_etf: '511360' | '511880';
  market_data: {
    current_price_511360: number;
    current_price_511880: number;
  };
}

// System Configuration Types
export interface SystemConfig {
  trigger_line: number;
  commission_rate: number;
  commission_min: number;
  safe_layer_primary: string;
  safe_layer_backup: string;
  safe_layer_name_primary: string;
  safe_layer_name_backup: string;
  ambition_layer_name: string;
}

// Strategy Evolution Types
export interface StrategyReport {
  id: number;
  user_id: number;
  report_data: string; // JSON stored as text
  pbo_score: number;
  dsr_ranking: number;
  parameter_count: number;
  evolution_timestamp: string;
  next_scheduled_evolution?: string;
  created_at: string;
}

export interface MPTResult {
  expected_return: number;
  volatility: number;
  sharpe_ratio: number;
  portfolio_weights: {
    symbol: string;
    weight: number;
  }[];
}

export interface MonteCarloResult {
  worst_case: number;
  best_case: number;
  average_case: number;
  probability_loss_10_percent: number;
  probability_return_20_percent: number;
  confidence_intervals: {
    lower_95: number;
    upper_95: number;
  };
}

export interface WalkForwardResult {
  optimal_parameters: {
    [key: string]: number;
  };
  performance_metrics: {
    sharpe_ratio: number;
    max_drawdown: number;
    win_rate: number;
  };
  parameter_stability: number;
  dsr_ranking: number;
}

// API Response Types
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
  };
}

// Dashboard Data Types
export interface DashboardData {
  portfolio: Portfolio;
  positions: Position[];
  recent_transactions: Transaction[];
  trigger_status: {
    current_balance: number;
    trigger_line: number;
    status: 'accumulating' | 'triggerable';
    last_decision?: TriggerDecision;
    last_decision_time?: string;
  };
  strategy_evolution: {
    last_evolution: string;
    days_since_evolution: number;
    pbo_score: number;
    status_color: 'green' | 'yellow' | 'red';
  };
}

// Form Types
export interface TransactionForm {
  symbol: string;
  shares: number;
  price: number;
  transaction_type: 'buy' | 'sell';
  trigger_signal?: string;
  layer: 'safe' | 'ambition';
  notes?: string;
}

export interface ReconciliationData {
  broker_transactions: Transaction[];
  system_transactions: Transaction[];
  differences: {
    symbol: string;
    broker_shares: number;
    system_shares: number;
    difference: number;
    percentage_difference: number;
  }[];
}

// ETF Constants
export const ETF_CONSTANTS = {
  SAFE_LAYER: {
    PRIMARY: {
      SYMBOL: '511360',
      NAME: '海富通短融ETF',
    },
    BACKUP: {
      SYMBOL: '511880',
      NAME: '银华日利',
    },
  },
  AMBITION_LAYER: {
    NAME: '权益ETF',
  },
} as const;

// Trigger Constants
export const TRIGGER_CONSTANTS = {
  LINE: 1667,
  COMMISSION_RATE: 0.0003,
  COMMISSION_MIN: 5,
} as const;
