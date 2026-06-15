import { Context } from 'hono';
import { db } from '../lib/database';
import { TransactionForm, ApiResponse } from '../lib/types';

/**
 * Get Transactions API Endpoint
 * 
 * GET /api/transactions
 * Returns transaction history for user
 */
export async function handleTransactionsRequest(c: Context): Promise<Response> {
  try {
    const userId = parseInt(c.req.param('userId'));
    if (!userId || userId <= 0) {
      return c.json({
        success: false,
        error: 'Invalid user ID',
        message: 'User ID must be a positive number',
      }, 400);
    }
    
    const limit = parseInt(c.req.query('limit') || '100');
    const transactions = await db.getTransactions(userId, limit);
    
    return c.json({
      success: true,
      data: transactions,
      message: 'Transactions retrieved successfully',
    }, 200);

  } catch (error) {
    console.error('Transactions request error:', error);
    return c.json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to retrieve transactions',
    }, 500);
  }
}

/**
 * Create Transaction API Endpoint
 * 
 * POST /api/transactions
 * Records a new transaction for user
 */
export async function handleCreateTransactionRequest(c: Context): Promise<Response> {
  try {
    const userId = parseInt(c.req.param('userId'));
    if (!userId || userId <= 0) {
      return c.json({
        success: false,
        error: 'Invalid user ID',
        message: 'User ID must be a positive number',
      }, 400);
    }
    
    const transactionForm: TransactionForm = await c.req.json();
    
    // Validate transaction form
    if (!transactionForm || typeof transactionForm !== 'object') {
      return c.json({
        success: false,
        error: 'Invalid transaction data',
        message: 'Transaction data must be an object',
      }, 400);
    }
    
    // Validate required fields
    const requiredFields = ['symbol', 'shares', 'price', 'transaction_type', 'layer'];
    for (const field of requiredFields) {
      if (!transactionForm[field]) {
        return c.json({
          success: false,
          error: 'Missing required field',
          message: `${field} is required`,
        }, 400);
      }
    }
    
    // Validate transaction type
    if (!['buy', 'sell'].includes(transactionForm.transaction_type)) {
      return c.json({
        success: false,
        error: 'Invalid transaction type',
        message: 'Transaction type must be either "buy" or "sell"',
      }, 400);
    }
    
    // Validate layer
    if (!['safe', 'ambition'].includes(transactionForm.layer)) {
      return c.json({
        success: false,
        error: 'Invalid layer',
        message: 'Layer must be either "safe" or "ambition"',
      }, 400);
    }
    
    // Validate shares and price
    if (transactionForm.shares <= 0 || transactionForm.price <= 0) {
      return c.json({
        success: false,
        error: 'Invalid values',
        message: 'Shares and price must be positive numbers',
      }, 400);
    }
    
    // Calculate amount
    const amount = transactionForm.shares * transactionForm.price;
    
    // Record the transaction
    const transaction = await db.recordManualTransaction(userId, {
      ...transactionForm,
      amount,
    });
    
    return c.json({
      success: true,
      data: transaction,
      message: 'Transaction recorded successfully',
    }, 201);

  } catch (error) {
    console.error('Create transaction error:', error);
    return c.json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to record transaction',
    }, 500);
  }
}

/**
 * Calculate Commission API Endpoint
 * 
 * POST /api/transactions/calculate-commission
 * Calculates commission for a given amount
 */
export async function handleCalculateCommissionRequest(c: Context): Promise<Response> {
  try {
    const body = await c.req.json();
    const amount = parseFloat(body.amount);
    
    if (isNaN(amount) || amount <= 0) {
      return c.json({
        success: false,
        error: 'Invalid amount',
        message: 'Amount must be a positive number',
      }, 400);
    }
    
    // Calculate commission: max(amount * 0.03%, 5)
    const commission = Math.max(amount * 0.0003, 5);
    
    return c.json({
      success: true,
      data: {
        amount,
        commission: commission.toFixed(2),
        commission_rate: 0.0003,
        commission_min: 5,
      },
      message: 'Commission calculated successfully',
    }, 200);

  } catch (error) {
    console.error('Calculate commission error:', error);
    return c.json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to calculate commission',
    }, 500);
  }
}
