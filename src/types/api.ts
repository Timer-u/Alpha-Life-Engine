// API Type Contract - Alpha-Life Engine
// Shared TypeScript interfaces for frontend/backend communication

export interface ApiResponse<T = any> {
  success: boolean;
  data: T;
  error?: string;
  timestamp: string;
}

export interface PortfolioBalance {
  totalBalance: number;
  safeLayerBalance: number;
  ambitionLayerBalance: number;
  availableBalance: number;
  lockedBalance: number;
}

export interface Transaction {
  id: string;
  type: 'BUY' | 'SELL';
  symbol: string;
  shares: number;
  price: number;
  amount: number;
  commission: number;
  timestamp: string;
  layer: 'SAFE' | 'AMBITION';
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
}

export interface TriggerSignal {
  type: 'SKIP' | 'DEFER' | 'EXECUTE' | 'DOUBLE' | 'NORMAL';
  strength: number;
  reason: string;
  timestamp: string;
}

export interface TriggerDecision {
  action: 'BUY' | 'SKIP' | 'DEFER';
  amount: number;
  signal: TriggerSignal;
  timestamp: string;
  nextBalance: PortfolioBalance;
}

export interface SafeLayerConfig {
  primaryETF: '511360'; // 海富通短融 ETF
  backupETF: '511880'; // 银华日利
  allocationRatio: number;
  expectedReturn: number; // 年化收益率
}

export interface MarketData {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  timestamp: string;
}

export interface UserConfig {
  id: string;
  email: string;
  triggerAmount: number; // 1667
  commissionRate: number; // 0.03%
  minCommission: number; // 5
  safeLayerConfig: SafeLayerConfig;
  timezone: string;
  notifications: {
    email: boolean;
    strategyEvolution: boolean;
  };
}

export interface StrategyEvolutionReport {
  id: string;
  timestamp: string;
  pboScore: number; // Parameter Bootstrap Overfitting
  dsrScore: number; // Dynamic Sharpe Ratio
  parameterCount: number;
  parameterStability: number;
  mptFrontier: Array<{
    risk: number;
    return: number;
    sharpe: number;
  }>;
  monteCarloResults: {
    var95: number;
    var99: number;
    expectedReturn: number;
    volatility: number;
  };
  recommendations: string[];
  nextEvolution: string;
}

export interface EvolutionTrigger {
  type: 'TIME_BASED' | 'MARKET_CONDITION' | 'MANUAL';
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  timestamp: string;
  condition: string;
}

export interface BaoStockConfig {
  apiKey?: string;
  dataPath: string;
  symbols: string[];
  updateFrequency: 'DAILY' | 'WEEKLY' | 'MONTHLY';
}

export interface CloudflareConfig {
  access: {
    domain: string;
    sessionDays: number;
    emailWhitelist: string[];
  };
  pages: {
    domain: string;
  };
  resend: {
    apiKey: string;
    fromEmail: string;
  };
}

export interface SystemHealth {
  database: {
    status: 'healthy' | 'degraded' | 'unhealthy';
    lastUpdate: string;
    latency: number;
  };
  marketData: {
    status: 'fresh' | 'stale' | 'error';
    lastUpdate: string;
    symbolsCount: number;
  };
  strategyEngine: {
    status: 'operational' | 'limited' | 'down';
    lastRun: string;
    queueSize: number;
  };
}

export interface UserSession {
  id: string;
  userId: string;
  email: string;
  expiresAt: string;
  lastActivity: string;
  ip: string;
  userAgent: string;
}
