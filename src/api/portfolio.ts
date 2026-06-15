import { Context } from 'hono';
import { db } from '../lib/database';
import { ApiResponse, DashboardData } from '../lib/types';

/**
 * Get Portfolio API Endpoint
 * 
 * GET /api/portfolio
 * Returns complete portfolio data for user
 */
export async function handlePortfolioRequest(c: Context): Promise<Response> {
  try {
    const userId = parseInt(c.req.param('userId'));
    if (!userId || userId <= 0) {
      return c.json({
        success: false,
        error: 'Invalid user ID',
        message: 'User ID must be a positive number',
      }, 400);
    }
    
    // Get portfolio data
    const portfolio = await db.getPortfolio(userId);
    if (!portfolio) {
      return c.json({
        success: false,
        error: 'Portfolio not found',
        message: 'No portfolio found for this user',
      }, 404);
    }
    
    // Get positions
    const positions = await db.getPositions(userId);
    
    // Get recent transactions
    const recentTransactions = await db.getRecentTransactions(userId, 10);
    
    // Get trigger status (mock data for now)
    const triggerStatus = {
      current_balance: portfolio.total_balance,
      trigger_line: 1667,
      status: (portfolio.total_balance < 1667 ? 'accumulating' : 'triggerable') as 'accumulating' | 'triggerable',
      last_decision: undefined, // Would be populated from trigger log
      last_decision_time: undefined,
    };
    
    // Get strategy evolution status
    const strategyEvolution = {
      last_evolution: '2024-01-01', // Would be from strategy reports
      days_since_evolution: 45,
      pbo_score: 0.35,
      status_color: 'yellow' as const,
    };
    
    const dashboardData: DashboardData = {
      portfolio,
      positions,
      recent_transactions: recentTransactions,
      trigger_status: triggerStatus,
      strategy_evolution: strategyEvolution,
    };
    
    return c.json({
      success: true,
      data: dashboardData,
      message: 'Portfolio data retrieved successfully',
    }, 200);

  } catch (error) {
    console.error('Portfolio request error:', error);
    return c.json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to retrieve portfolio data',
    }, 500);
  }
}

/**
 * Get Portfolio Summary API Endpoint
 * 
 * GET /api/portfolio/summary
 * Returns portfolio summary for user
 */
export async function handlePortfolioSummaryRequest(c: Context): Promise<Response> {
  try {
    const userId = parseInt(c.req.param('userId'));
    if (!userId || userId <= 0) {
      return c.json({
        success: false,
        error: 'Invalid user ID',
        message: 'User ID must be a positive number',
      }, 400);
    }
    
    const summary = await db.getPortfolioSummary(userId);
    if (!summary) {
      return c.json({
        success: false,
        error: 'Summary not found',
        message: 'No portfolio summary found for this user',
      }, 404);
    }
    
    return c.json({
      success: true,
      data: summary,
      message: 'Portfolio summary retrieved successfully',
    }, 200);

  } catch (error) {
    console.error('Portfolio summary error:', error);
    return c.json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to retrieve portfolio summary',
    }, 500);
  }
}

/**
 * Update Portfolio API Endpoint
 * 
 * PUT /api/portfolio
 * Updates portfolio data for user
 */
export async function handleUpdatePortfolioRequest(c: Context): Promise<Response> {
  try {
    const userId = parseInt(c.req.param('userId'));
    if (!userId || userId <= 0) {
      return c.json({
        success: false,
        error: 'Invalid user ID',
        message: 'User ID must be a positive number',
      }, 400);
    }
    
    const updates = await c.req.json();
    
    // Validate updates
    if (!updates || typeof updates !== 'object') {
      return c.json({
        success: false,
        error: 'Invalid updates',
        message: 'Updates must be an object',
      }, 400);
    }
    
    const success = await db.updatePortfolio(userId, updates);
    if (!success) {
      return c.json({
        success: false,
        error: 'Update failed',
        message: 'Failed to update portfolio data',
      }, 500);
    }
    
    return c.json({
      success: true,
      message: 'Portfolio updated successfully',
    }, 200);

  } catch (error) {
    console.error('Update portfolio error:', error);
    return c.json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to update portfolio',
    }, 500);
  }
}
