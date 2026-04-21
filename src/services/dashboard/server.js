import express from 'express';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { getEntries } from '../../logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = join(__dirname, 'public', 'index.html');

/**
 * Create the dashboard Express app.
 *
 * Serves a tiny static UI at `/` and JSON endpoints for health, tokens,
 * schema introspection, DynamoDB table contents, and the in-process log
 * ring buffer.
 *
 * @param {object} opts
 * @param {object} opts.config - Loaded amplify-local config (ports, output)
 * @param {object} opts.parsedSchema - Output of parseSchema()
 * @param {object} opts.services - Map of running services: { graphql: { url, port }, ... }
 * @param {string} opts.apiKey - The local API key
 * @param {DynamoDBClient} opts.dynamoClient - For ListTables
 * @param {DynamoDBDocumentClient} opts.docClient - For Scan
 * @param {() => string|null} [opts.tokensPath] - Path to tokens.json (test injection)
 */
export function createDashboardServer({
  config,
  parsedSchema,
  services,
  apiKey,
  dynamoClient,
  docClient,
  tokensPath,
}) {
  const app = express();
  app.use(express.json());

  // Local dev CORS
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (_req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Static: serve the single HTML page
  app.get('/', (_req, res) => {
    if (!existsSync(INDEX_HTML)) {
      return res.status(500).type('text').send('Dashboard UI not found');
    }
    res.type('html').send(readFileSync(INDEX_HTML, 'utf8'));
  });

  // ---- /api/health ----------------------------------------------------------
  app.get('/api/health', async (_req, res) => {
    const checks = {};
    for (const [name, info] of Object.entries(services || {})) {
      checks[name] = {
        url: info.url || `http://localhost:${info.port}`,
        port: info.port,
        status: await probe(info.url || `http://localhost:${info.port}`),
      };
    }
    checks.dynamodb = {
      endpoint: `http://localhost:${config.ports.dynamodb}`,
      status: await probeDynamo(dynamoClient),
    };
    res.json({
      startedAt: services?._startedAt || null,
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      services: checks,
    });
  });

  // ---- /api/tokens ----------------------------------------------------------
  app.get('/api/tokens', (_req, res) => {
    const path = tokensPath
      ? tokensPath()
      : join(process.cwd(), '.amplify-local', 'tokens.json');
    let users = {};
    if (path && existsSync(path)) {
      try {
        users = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        users = {};
      }
    }
    res.json({ apiKey, users });
  });

  // ---- /api/schema ----------------------------------------------------------
  app.get('/api/schema', (_req, res) => {
    const summary = {
      models: Object.fromEntries(
        Object.entries(parsedSchema.models).map(([name, m]) => [
          name,
          {
            fields: Object.fromEntries(
              Object.entries(m.fields).map(([f, info]) => [
                f,
                { type: info.type, required: info.required, array: info.array },
              ])
            ),
            relationships: m.relationships,
            enums: m.enums,
            primaryKey: m.primaryKey,
            secondaryIndexes: m.secondaryIndexes || [],
            authorization: m.authorization || [],
          },
        ])
      ),
      enums: parsedSchema.enums,
      authorizationModes: parsedSchema.authorizationModes,
    };
    res.json(summary);
  });

  // ---- /api/tables ----------------------------------------------------------
  app.get('/api/tables', async (_req, res) => {
    try {
      const r = await dynamoClient.send(new ListTablesCommand({}));
      const modelNames = new Set(Object.keys(parsedSchema.models));
      const tables = (r.TableNames || []).map((name) => ({
        name,
        managed: modelNames.has(name),
      }));
      res.json({ tables });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.get('/api/tables/:name', async (req, res) => {
    const name = req.params.name;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    try {
      const r = await docClient.send(new ScanCommand({ TableName: name, Limit: limit }));
      res.json({
        table: name,
        count: r.Count ?? (r.Items?.length || 0),
        scannedCount: r.ScannedCount ?? 0,
        items: r.Items || [],
      });
    } catch (err) {
      const status = err.name === 'ResourceNotFoundException' ? 404 : 502;
      res.status(status).json({ error: err.message });
    }
  });

  // ---- /api/logs ------------------------------------------------------------
  app.get('/api/logs', (req, res) => {
    const since = req.query.since ? parseInt(req.query.since, 10) : undefined;
    const entries = getEntries({ since });
    res.json({
      entries,
      lastSeq: entries.length > 0 ? entries[entries.length - 1].seq : since || 0,
    });
  });

  return app;
}

async function probe(url) {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(1500),
    });
    return res.status < 500 ? 'healthy' : 'unhealthy';
  } catch {
    return 'unreachable';
  }
}

async function probeDynamo(dynamoClient) {
  try {
    await dynamoClient.send(new ListTablesCommand({}));
    return 'healthy';
  } catch {
    return 'unreachable';
  }
}
