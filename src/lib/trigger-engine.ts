import {
  type ActiveAllocation,
  type SignalType,
  type TriggerDecision,
  type TriggerInput,
  type TriggerResponse,
  TRIGGER_CONSTANTS,
  isEvolvedParams,
} from '../types/api';

export interface MarketPrices {
  [symbol: string]: number;
}

/**
 * Alpha-Life Engine Trigger Decision Engine
 *
 * Core domain logic: determines whether accumulated capital crosses the
 * trigger line (default 1667 yuan) and executes buy-in to the ambition
 * layer. Uses a dual-layer (safe + ambition) account structure with
 * allocation ratios from LCH or evolved strategy params. Market prices
 * are injected from the MarketData D1 table.
 */
export class TriggerDecisionEngine {

  private calculateCommission(amount: number): number {
    const commission = amount * TRIGGER_CONSTANTS.COMMISSION_RATE;
    return Math.max(commission, TRIGGER_CONSTANTS.COMMISSION_MIN);
  }

  private getNextSafeETF(): '511360' | '511880' {
    return '511360';
  }

  /**
   * @param marketPrices - Current prices from MarketData D1 (injected, not hardcoded)
   * @param activeParams - LCH or evolved strategy params (safe_ratio, ambition_ratio, etc.)
   *
   * Commission is calculated on trigger_line (not executed_amount), because
   * executed_amount always equals trigger_line for EXECUTE decisions.
   */
  public makeTriggerDecision(
    input: TriggerInput,
    marketPrices: MarketPrices = {},
    activeParams: ActiveAllocation | null = null
  ): TriggerResponse {
    const { current_balance, signal_value, signal_type } = input;

    const trigger_line = activeParams && isEvolvedParams(activeParams) ? (activeParams.trigger_line ?? TRIGGER_CONSTANTS.LINE) : TRIGGER_CONSTANTS.LINE;
    const safeRatio = activeParams?.safe_ratio ?? 0.6;
    const ambitionRatio = activeParams?.ambition_ratio ?? 0.4;
    const bsmThreshold = activeParams && isEvolvedParams(activeParams) ? (activeParams.bsm_threshold ?? 1.4) : 1.4;

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
    } else if (current_balance >= trigger_line && signal_type === 'BSM' && signal_value >= bsmThreshold) {
      decision = 'EXECUTE';
      executed_amount = trigger_line;
      message = `恐慌入场信号 (BSM >= ${bsmThreshold})，执行买入 ${trigger_line} 元`;
    } else if (current_balance >= trigger_line && (signal_type === 'DOUBLE' || signal_type === 'NORMAL')) {
      decision = 'EXECUTE';
      executed_amount = trigger_line;
      message = `标准买入信号 (${signal_type})，执行买入 ${trigger_line} 元`;
    } else {
      decision = 'DEFER';
      message = `其他条件，资金继续在安全层生息`;
    }

    let safe_amount: number;
    let ambition_amount: number;

    if (decision === 'EXECUTE') {
      safe_amount = executed_amount! * safeRatio;
      ambition_amount = executed_amount! * ambitionRatio;
    } else if (decision === 'DEFER') {
      safe_amount = current_balance;
      ambition_amount = 0;
    } else {
      safe_amount = current_balance;
      ambition_amount = 0;
    }

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
   * Validates trigger input parameters before processing.
   * Checks user_id > 0, current_balance >= 0, signal_value >= 0,
   * and signal_type is one of the valid SignalType values.
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
   * Logs a trigger decision for audit/debugging purposes.
   * Outputs user_id, balance, decision, signal_value, executed_amount,
   * commission, and timestamp to the console.
   */
  public logTriggerDecision(
    user_id: number,
    balance: number,
    decision: TriggerDecision,
    signal_value: number,
    executed_amount: number,
    commission: number
  ): void {
    console.warn(`[Trigger] Decision:`, {
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

export const triggerEngine = new TriggerDecisionEngine();

