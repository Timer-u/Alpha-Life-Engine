import { Hono } from 'hono';
import { handlePortfolioRequest, handlePortfolioSummaryRequest, handleUpdatePortfolioRequest } from '../../src/api/portfolio';

const app = new Hono();

// Get portfolio endpoint
app.get('/:userId', handlePortfolioRequest);

// Get portfolio summary endpoint
app.get('/summary/:userId', handlePortfolioSummaryRequest);

// Update portfolio endpoint
app.put('/:userId', handleUpdatePortfolioRequest);

export default app;
