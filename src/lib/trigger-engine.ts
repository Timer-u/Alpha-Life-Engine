import {
  TriggerInput,
  TriggerResponse,
  TriggerDecision,
  SignalType,
  LayerType,
} from './types';
import { TRIGGER_CONSTANTS, ETF_CONSTANTS } from './types';

/**
 * Alpha-Life Engine Trigger Decision Engine
 * 
 * Implements the 1667 yuan trigger line logic with dual-layer account structure
 */
export class TriggerDecisionEngine {
  // Current market prices (mock data for now)
  private marketPrices = {
    '511360': 100.25, // 海富通短融ETF current price
    '511880': 99.98,  // 银华日利 current price
    '权益ETF': 102.15, // Ambition layer ETF
  };

  /**
   * Calculate commission based on amount
   * Formula: max(amount * commission_rate, commission_min)
   */
  private calculateCommission(amount: number): number {
    const commission = amount * TRIGGER_CONSTANTS.COMMISSION_RATE;
    return Math.max(commission, TRIGGER_CONSTANTS.COMMISSION_MIN);
  }

  /**
   * Determine the next safe layer ETF to use
   * Primary: 511360 (海富通短融ETF)
   * Backup: 511880 (银华日利) if primary needs rotation
   */
  private getNextSafeETF(): '511360' | '511880' {
    // For now, always use primary as backup logic will be added later
    return '511360';
  }

  /**
   * Main trigger decision logic
   * 
   * Conditions:
   * - Balance < 1667: DEFER, safe layer generates interest
   * - Balance >= 1667, signal SKIP: SKIP, funds stay in safe layer
   * - Balance >= 1667, BSM >= 1.4: EXECUTE 1667 (panic entry)
   * - Balance >= 1667, DOUBLE/NORMAL: EXECUTE 1667 (standard buy)
   * - Other: DEFER, safe layer continues to generate interest
   */
  public makeTriggerDecision(input: TriggerInput): TriggerResponse {
    const { current_balance, signal_value, signal_type } = input;
    const trigger_line = TRIGGER_CONSTANTS.LINE;

    // Always calculate commission
    const commission = this.calculateCommission(trigger_line);
    
    // Determine decision based on conditions
    let decision: TriggerDecision;
    let message: string;
    let executed_amount: number | undefined;

    if (current_balance < trigger_line) {
      // Balance < 1667: DEFER, safe layer generates interest
      decision = 'DEFER';
      message = `余额 ${current_balance.toFixed(2)} 元 < 触发线 ${trigger_line} 元，资金留在安全层生息`;
      
    } else if (current_balance >= trigger_line && signal_type === 'SKIP') {
      // Balance >= 1667, signal SKIP: SKIP, funds stay in safe layer
      decision = 'SKIP';
      message = `信号 SKIP，资金留在安全层不执行操作`;
      
    } else if (current_balance >= trigger_line && signal_type === 'BSM' && signal_value >= 1.4) {
      // Balance >= 1667, BSM >= 1.4: EXECUTE 1667 (panic entry)
      decision = 'EXECUTE';
      executed_amount = trigger_line;
      message = `恐慌入场信号 (BSM >= 1.4)，执行买入 ${trigger_line} 元`;
      
    } else if (current_balance >= trigger_line && (signal_type === 'DOUBLE' || signal_type === 'NORMAL')) {
      // Balance >= 1667, DOUBLE/NORMAL: EXECUTE 1667 (standard buy)
      decision = 'EXECUTE';
      executed_amount = trigger_line;
      message = `标准买入信号 (${signal_type})，执行买入 ${trigger_line} 元`;
      
    } else {
      // Other conditions: DEFER, safe layer continues to generate interest
      decision = 'DEFER';
      message = `其他条件，资金继续在安全层生息`;
    }

    // Calculate layer allocation
    const safe_amount = decision === 'EXECUTE' ? executed_amount! * 0.6 : current_balance;
    const ambition_amount = decision === 'EXECUTE' ? executed_amount! * 0.4 : 0;

    return {
      decision,
      executed_amount: executed_amount,
      commission,
      layer_allocation: {
        safe_amount,
        ambition_amount,
      },
      message,
      next_safe_etf: this.getNextSafeETF(),
      market_data: {
        current_price_511360: this.marketPrices['511360'],
        current_price_511880: this.marketPrices['511880'],
      },
    };
  }

  /**
   * Validate trigger input parameters
   */
  public validateTriggerInput(input: TriggerInput): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (input.user_id <= 0) {
      errors.push('用户ID必须大于0');
    }

    if (input.current_balance < 0) {
      errors.push('当前余额不能为负数');
    }

    if (input.signal_value < 0) {
      errors.push('信号值不能为负数');
    }

    const validSignalTypes: SignalType[] = ['BSM', 'DOUBLE', 'NORMAL', 'SKIP'];
    if (!validSignalTypes.includes(input.signal_type)) {
      errors.push('无效的信号类型');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Log trigger decision to database
   * This would be implemented in the database operations layer
   */
  public logTriggerDecision(
    user_id: number,
    balance: number,
    decision: TriggerDecision,
    signal_value: number,
    executed_amount: number,
    commission: number
  ): void {
    // This would insert into trigger_log table
    console.log(`Logging trigger decision:`, {
      user_id,
      balance,
      decision,
      signal_value,
      executed_amount,
      commission,
      created_at: new Date().toISOString(),
    });
  }

  /**
   * Update market prices (for real data integration later)
   */
  public updateMarketPrices(prices: { [key: string]: number }): void {
    this.marketPrices = { ...this.marketPrices, ...prices };
  }

  /**
   * Get current market prices
   */
  public getMarketPrices(): { [key: string]: number } {
    return { ...this.marketPrices };
  }
}

// Export a singleton instance for use across the application
export const triggerEngine = new TriggerDecisionEngine();
