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
  LINE: 1667 as const,
  COMMISSION_RATE: 0.0003 as const,
  COMMISSION_MIN: 5 as const,
} as const;

export const ETF_CONSTANTS = {
  SAFE_PRIMARY: '511360',
  SAFE_PRIMARY_NAME: '海富通短融ETF',
  SAFE_BACKUP: '511880',
  SAFE_BACKUP_NAME: '银华日利',
} as const;

// Database Entity Types
export interface User {
  id: number;
  email: string;
  name: string | null;
  avatar_url: string | null;
  phone: string | null;
  preferences: string | null;
  created_at: string;
  updated_at: string;
}

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

export interface MarketData {
  id: number;
  symbol: string;
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  created_at: string;
}

export interface StrategyReport {
  id: number;
  user_id: number;
  report_data: string;
  pbo_score: number | null;
  dsr_ranking: number | null;
  parameter_count: number;
  evolution_timestamp: string;
  next_scheduled_evolution: string | null;
  created_at: string;
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

export function isLCHAllocation(a: ActiveAllocation): a is LCHAllocation {
  return a.source === 'lch';
}

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

export interface MarketPriceData {
  [symbol: string]: number;
}

// Frontend UI Types
export interface EvolutionStatus {
  lastEvolution: string | null;
  daysSince: number;
  pboScore: number | null;
  status: 'green' | 'yellow' | 'red';
}

export interface TriggerProgress {
  currentBalance: number;
  triggerLine: number;
  percentage: number;
  status: 'accumulating' | 'triggerable';
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
