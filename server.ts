import express from 'express';
import { createApiRouter } from './src/routes.js';
import { renderAppHtml } from './src/template.js';

const app = express();
const envPort = Number(process.env.DEFAULT_APP_PORT || process.env.PORT);
const PORT = envPort && envPort !== 8080 ? envPort : 3000;
const HOST = '0.0.0.0';

app.set('trust proxy', true);
app.use(express.json({ limit: '32mb' }));
app.use(express.urlencoded({ extended: true, limit: '32mb' }));

const apiRouter = createApiRouter();
app.use('/mlp/v1', apiRouter);
app.use('/wp-json/mlp/v1', apiRouter);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/', (req, res) => {
  const host = req.get('host') || `localhost:${PORT}`;
  const origin = `${req.protocol}://${host}`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderAppHtml(origin));
});

app.listen(PORT, HOST, () => {
  console.log(`Ptero AI Chat server listening on http://${HOST}:${PORT}`);
});
