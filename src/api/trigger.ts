import { Context } from 'hono';
import { triggerEngine } from '../lib/trigger-engine';
import { db } from '../lib/database';
import { TriggerInput, TriggerResponse, ApiResponse } from '../lib/types';

/**
 * Trigger Decision API Endpoint
 * 
 * POST /api/trigger
 * Main endpoint for trigger decision logic
 */
export async function handleTriggerRequest(c: Context): Promise<Response> {
  try {
    // Parse request body
    const input: TriggerInput = await c.req.json();
    
    // Validate input
    const validation = triggerEngine.validateTriggerInput(input);
    if (!validation.valid) {
      return c.json({
        success: false,
        error: 'Invalid input',
        message: validation.errors.join(', '),
      }, 400);
    }
    
    // Make trigger decision
    const response: TriggerResponse = triggerEngine.makeTriggerDecision(input);
    
    // Log the decision to database
    triggerEngine.logTriggerDecision(
      input.user_id,
      input.current_balance,
      response.decision,
      input.signal_value,
      response.executed_amount || 0,
      response.commission
    );

    // Return success response
    return c.json({
      success: true,
      data: response,
      message: 'Trigger decision completed successfully',
    }, 200);

  } catch (error) {
    console.error('Trigger request error:', error);
    return c.json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to process trigger decision',
    }, 500);
  }
}

/**
 * Get Market Prices API Endpoint
 * 
 * GET /api/trigger/market-prices
 * Returns current market prices for ETFs
 */
export async function handleMarketPricesRequest(c: Context): Promise<Response> {
  try {
    const prices = triggerEngine.getMarketPrices();
    
    return c.json({
      success: true,
      data: prices,
      message: 'Market prices retrieved successfully',
    }, 200);

  } catch (error) {
    console.error('Market prices error:', error);
    return c.json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to retrieve market prices',
    }, 500);
  }
}
