import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createDashboardServer } from '../../src/services/dashboard/server.js';
import { parseSchema } from '../../src/parser/index.js';
import { _reset as resetLogger, info, warn } from '../../src/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, '..', 'fixtures', 'minimal-amplify');

// Fakes stand in for DynamoDB so the dashboard can be exercised as a unit.
function fakeDynamoClient({ tables = [], fail = false } = {}) {
  return {
    async send(cmd) {
      if (fail) throw new Error('boom');
      if (cmd.constructor.name === 'ListTablesCommand') {
        return { TableNames: tables };
      }
      throw new Error(`unexpected command: ${cmd.constructor.name}`);
    },
  };
}

function fakeDocClient({ items = {}, missing = [] } = {}) {
  return {
    async send(cmd) {
      const name = cmd.input.TableName;
      if (missing.includes(name)) {
        const err = new Error(`Table not found: ${name}`);
        err.name = 'ResourceNotFoundException';
        throw err;
      }
      const rows = items[name] || [];
      return { Items: rows, Count: rows.length, ScannedCount: rows.length };
    },
  };
}

let parsed;
let tmpTokensDir;

beforeAll(async () => {
  parsed = await parseSchema(FIXTURE);
  tmpTokensDir = mkdtempSync(join(tmpdir(), 'amplify-local-dashtest-'));
  mkdirSync(join(tmpTokensDir, '.amplify-local'), { recursive: true });
  writeFileSync(
    join(tmpTokensDir, '.amplify-local', 'tokens.json'),
    JSON.stringify({
      'admin@test.local': { idToken: 'abc.def.ghi', accessToken: 'xyz.uvw.rst' },
    })
  );
});

beforeEach(() => {
  resetLogger();
});

function buildApp(overrides = {}) {
  return createDashboardServer({
    config: {
      ports: { graphql: 4502, storage: 4503, rest: 4504, dynamodb: 8000, dashboard: 4501 },
      output: '/tmp/amplify_outputs.json',
    },
    parsedSchema: parsed,
    services: {
      graphql: { port: 4502, url: 'http://localhost:4502/graphql' },
    },
    apiKey: 'test-api-key-000000',
    dynamoClient: fakeDynamoClient({ tables: ['Category', 'Product', 'Review', 'LegacyTable'] }),
    docClient: fakeDocClient({
      items: {
        Category: [{ id: '1', name: 'Cars' }],
        Product: [],
      },
    }),
    tokensPath: () => join(tmpTokensDir, '.amplify-local', 'tokens.json'),
    ...overrides,
  });
}

describe('dashboard — GET /', () => {
  it('serves the static HTML', async () => {
    const res = await request(buildApp()).get('/').expect(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('amplify-local');
    expect(res.text).toContain('<nav>');
  });
});

describe('dashboard — /api/health', () => {
  it('lists each service, its URL, and its probe status', async () => {
    const res = await request(buildApp()).get('/api/health').expect(200);
    expect(res.body).toHaveProperty('pid');
    expect(res.body).toHaveProperty('uptimeSeconds');
    expect(res.body.services).toHaveProperty('graphql');
    expect(res.body.services).toHaveProperty('dynamodb');
    // The probe hits unroutable ports during tests, so statuses are unreachable;
    // DynamoDB is healthy since we fake its client.
    expect(res.body.services.dynamodb.status).toBe('healthy');
    expect(['healthy', 'unhealthy', 'unreachable']).toContain(res.body.services.graphql.status);
  });

  it('reports dynamodb unreachable when ListTables throws', async () => {
    const app = buildApp({ dynamoClient: fakeDynamoClient({ fail: true }) });
    const res = await request(app).get('/api/health').expect(200);
    expect(res.body.services.dynamodb.status).toBe('unreachable');
  });
});

describe('dashboard — /api/tokens', () => {
  it('returns the API key and parsed tokens.json', async () => {
    const res = await request(buildApp()).get('/api/tokens').expect(200);
    expect(res.body.apiKey).toBe('test-api-key-000000');
    expect(res.body.users['admin@test.local'].idToken).toBe('abc.def.ghi');
  });

  it('returns apiKey alone when tokens.json is missing', async () => {
    const app = buildApp({ tokensPath: () => '/does/not/exist.json' });
    const res = await request(app).get('/api/tokens').expect(200);
    expect(res.body.apiKey).toBe('test-api-key-000000');
    expect(res.body.users).toEqual({});
  });
});

describe('dashboard — /api/schema', () => {
  it('returns a trimmed view of every model with fields and relationships', async () => {
    const res = await request(buildApp()).get('/api/schema').expect(200);
    expect(Object.keys(res.body.models).sort()).toEqual(['Category', 'Product', 'Review']);
    expect(res.body.models.Product.relationships.category).toMatchObject({
      type: 'belongsTo',
      model: 'Category',
    });
    expect(res.body.models.Product.secondaryIndexes.length).toBe(2);
    expect(res.body.models.Category.authorization.length).toBeGreaterThan(0);
  });
});

describe('dashboard — /api/tables', () => {
  it('returns tables and flags which are managed by the current schema', async () => {
    const res = await request(buildApp()).get('/api/tables').expect(200);
    const byName = Object.fromEntries(res.body.tables.map((t) => [t.name, t]));
    expect(byName.Category.managed).toBe(true);
    expect(byName.Product.managed).toBe(true);
    expect(byName.LegacyTable.managed).toBe(false);
  });

  it('502s when DynamoDB is unreachable', async () => {
    const app = buildApp({ dynamoClient: fakeDynamoClient({ fail: true }) });
    const res = await request(app).get('/api/tables').expect(502);
    expect(res.body.error).toBe('boom');
  });
});

describe('dashboard — /api/tables/:name', () => {
  it('scans and returns items with count', async () => {
    const res = await request(buildApp()).get('/api/tables/Category?limit=10').expect(200);
    expect(res.body.table).toBe('Category');
    expect(res.body.items).toEqual([{ id: '1', name: 'Cars' }]);
    expect(res.body.count).toBe(1);
  });

  it('404s for a missing table', async () => {
    const app = buildApp({
      docClient: fakeDocClient({ missing: ['Nope'] }),
    });
    const res = await request(app).get('/api/tables/Nope').expect(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('clamps limit to 500', async () => {
    let observed;
    const docClient = {
      async send(cmd) {
        observed = cmd.input.Limit;
        return { Items: [], Count: 0, ScannedCount: 0 };
      },
    };
    await request(buildApp({ docClient })).get('/api/tables/Category?limit=9999').expect(200);
    expect(observed).toBe(500);
  });
});

describe('dashboard — /api/logs', () => {
  it('returns all entries when no `since` param is provided', async () => {
    info('orchestrator', 'started');
    warn('graphql', 'slow');
    const res = await request(buildApp()).get('/api/logs').expect(200);
    expect(res.body.entries).toHaveLength(2);
    expect(res.body.lastSeq).toBe(2);
    expect(res.body.entries[1].level).toBe('warn');
  });

  it('returns only entries after since', async () => {
    info('x', 'one');
    info('x', 'two');
    info('x', 'three');
    const res = await request(buildApp()).get('/api/logs?since=1').expect(200);
    expect(res.body.entries.map((e) => e.message)).toEqual(['two', 'three']);
  });

  it('echoes since back as lastSeq when no new entries exist', async () => {
    info('x', 'one');
    const res = await request(buildApp()).get('/api/logs?since=10').expect(200);
    expect(res.body.entries).toEqual([]);
    expect(res.body.lastSeq).toBe(10);
  });
});
