import {
  TriggerInput,
  TriggerResponse,
  TriggerDecision,
  SignalType,
  LayerType,
  TRIGGER_CONSTANTS,
  ETF_CONSTANTS,
} from '../types/api';

export interface MarketPrices {
  [symbol: string]: number;
}

/**
 * Alpha-Life Engine Trigger Decision Engine
 * 
 * Implements the 1667 yuan trigger line logic with dual-layer account structure
 * 
 * Market prices are now injected from external sources (MarketData D1 table)
 * instead of using hardcoded mock values.
 */
export class TriggerDecisionEngine {

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
    return '511360';
  }

  /**
   * Main trigger decision logic
   * 
   * @param input - Trigger input parameters
   * @param marketPrices - Current market prices (injected from D1 or external source)
   */
  public makeTriggerDecision(
    input: TriggerInput,
    marketPrices: MarketPrices = {}
  ): TriggerResponse {
    const { current_balance, signal_value, signal_type } = input;
    const trigger_line = TRIGGER_CONSTANTS.LINE;

    const commission = this.calculateCommission(trigger_line);
    
    let decision: TriggerDecision;
    let message: string;
    let executed_amount: number | undefined;

    if (current_balance < trigger_line) {
      decision = 'DEFER';
      message = `余额 ${current_balance.toFixed(2)} 元 < 触发线 ${trigger_line} 元，资金留在安全层生息`;
    } else if (current_balance >= trigger_line && signal_type === 'SKIP') {
      decision = 'SKIP';
      message = `信号 SKIP，资金留在安全层不执行操作`;
    } else if (current_balance >= trigger_line && signal_type === 'BSM' && signal_value >= 1.4) {
      decision = 'EXECUTE';
      executed_amount = trigger_line;
      message = `恐慌入场信号 (BSM >= 1.4)，执行买入 ${trigger_line} 元`;
    } else if (current_balance >= trigger_line && (signal_type === 'DOUBLE' || signal_type === 'NORMAL')) {
      decision = 'EXECUTE';
      executed_amount = trigger_line;
      message = `标准买入信号 (${signal_type})，执行买入 ${trigger_line} 元`;
    } else {
      decision = 'DEFER';
      message = `其他条件，资金继续在安全层生息`;
    }

    const safe_amount = decision === 'EXECUTE' ? executed_amount! * 0.6 : current_balance;
    const ambition_amount = decision === 'EXECUTE' ? executed_amount! * 0.4 : 0;

    return {
      decision,
      executed_amount,
      commission,
      layer_allocation: {
        safe_amount,
        ambition_amount,
      },
      message,
      next_safe_etf: this.getNextSafeETF(),
      market_data: {
        current_price_511360: marketPrices['511360'] ?? 0,
        current_price_511880: marketPrices['511880'] ?? 0,
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
   * Log trigger decision to database (placeholder)
   */
  public logTriggerDecision(
    user_id: number,
    balance: number,
    decision: TriggerDecision,
    signal_value: number,
    executed_amount: number,
    commission: number
  ): void {
    console.log(`[Trigger] Decision:`, {
      user_id,
      balance,
      decision,
      signal_value,
      executed_amount,
      commission,
      created_at: new Date().toISOString(),
    });
  }
}

// Export a singleton instance
export const triggerEngine = new TriggerDecisionEngine();
