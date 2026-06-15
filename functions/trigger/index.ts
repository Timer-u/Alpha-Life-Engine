import { Hono } from 'hono';
import { handleTriggerRequest, handleMarketPricesRequest } from '../../src/api/trigger';

const app = new Hono();

// Main trigger endpoint
app.post('/', handleTriggerRequest);

// Market prices endpoint
app.get('/market-prices', handleMarketPricesRequest);

export default app;
