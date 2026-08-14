// ============================================================
// Alpha-Life Engine - Shared TypeScript Types
// ============================================================

export type TriggerDecision = 'DEFER' | 'SKIP' | 'EXECUTE';
export type SignalType = 'BSM' | 'DOUBLE' | 'NORMAL' | 'SKIP';
export type LayerType = 'safe' | 'ambition';
export type TransactionType = 'buy' | 'sell';

export interface TriggerInput {
  user_id: number;
  current_balance: number;
  signal_value: number;
  signal_type: SignalType;
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

export const TRIGGER_CONSTANTS = {
  LINE: 166700 as const,               // default trigger line, CENTS
  TRIGGER_LINE_DEFAULT_YUAN: 1667 as const,  // yuan-side default when an evolved param is missing
  COMMISSION_RATE: 0.0003 as const,
  COMMISSION_MIN_CENTS: 500 as const,
} as const;

export const ETF_CONSTANTS = {
  SAFE_PRIMARY: '511360',
  SAFE_PRIMARY_NAME: '海富通短融ETF',
  SAFE_BACKUP: '511880',
  SAFE_BACKUP_NAME: '银华日利',
} as const;

// Database Entity Types
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
  layer: LayerType;
  created_at: string;
  updated_at: string;
}

export interface Transaction {
  id: number;
  user_id: number;
  symbol: string;
  shares: number;
  price: number;
  amount: number;
  commission: number;
  transaction_type: TransactionType;
  trigger_signal: string | null;
  layer: LayerType;
  created_at: string;
  notes: string | null;
}

export interface TransactionForm {
  symbol: string;
  shares: number;
  price: number;
  amount?: number;
  commission?: number;
  transaction_type: TransactionType;
  trigger_signal?: string;
  layer: LayerType;
  notes?: string;
}

export interface AllocationWeight {
  symbol: string;
  weight: number;
}

export interface EvolvedParams {
  trigger_line?: number;
  safe_ratio?: number;
  ambition_ratio?: number;
  bsm_threshold?: number;
  ma_short_window?: number;
  ma_long_window?: number;
  safe_allocation?: AllocationWeight[];
  ambition_allocation?: AllocationWeight[];
  evolution_timestamp?: string;
  pbo_score?: number | null;
  dsr_ranking?: number | null;
  source: 'evolved';
}

export interface LCHAllocation {
  safe_ratio: number;
  ambition_ratio: number;
  source: 'lch';
  age: number;
}

export type ActiveAllocation = EvolvedParams | LCHAllocation;

export function isEvolvedParams(a: ActiveAllocation): a is EvolvedParams {
  return a.source === 'evolved';
}

export type ReconciliationStatus = 'PENDING' | 'CONFIRMED' | 'ARCHIVED';

export interface Reconciliation {
  id: number;
  user_id: number;
  reconciliation_date: string;
  beginning_balance: number;
  deposits: number;
  withdrawals: number;
  gains: number;
  fees: number;
  ending_balance: number;
  variance: number;
  notes: string | null;
  status: ReconciliationStatus;
  created_at: string;
  updated_at: string;
}

export interface ReconciliationComparison {
  system_cash: number;
  system_holdings_value: number;
  system_total: number;
  broker_balance: number;
  variance: number;
  variance_pct: number;
  needs_calibration: boolean;
}

export interface DepositResult {
  amount: number;
  safe_added: number;
  ambition_added: number;
  safe_ratio: number;
  ambition_ratio: number;
  allocation_source: 'evolved' | 'lch';
  portfolio: {
    total_balance: number;
    safe_layer_balance: number;
    ambition_layer_balance: number;
  };
}

export interface PerformancePoint {
  date: string;
  market_value: number;
  invested: number;
  cumulative_gain: number;
}

export interface LayerPerformance {
  safe: PerformancePoint[];
  ambition: PerformancePoint[];
}

// API Response Types
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  timestamp: string;
}

export interface DashboardData {
  portfolio: Portfolio | null;
  positions: Position[];
  recent_transactions: Transaction[];
  trigger_status: {
    current_balance: number;
    trigger_line: number;
    status: 'accumulating' | 'triggerable';
    last_decision?: string;
    last_decision_time?: string;
  };
  strategy_evolution: {
    last_evolution: string | null;
    days_since_evolution: number;
    pbo_score: number | null;
    status_color: 'green' | 'yellow' | 'red';
  };
}

export interface AuthSession {
  token: string;
  user: {
    id: number;
    email: string;
    name: string | null;
  };
  expires_at: string;
}

// Type guard for API responses
export function isApiResponse<T>(obj: unknown): obj is ApiResponse<T> {
  return (
    obj !== null &&
    typeof obj === 'object' &&
    'success' in obj &&
    typeof (obj as Record<string, unknown>).success === 'boolean'
  );
}
