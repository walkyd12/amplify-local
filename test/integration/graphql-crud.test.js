import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import {
  ListTablesCommand,
  DeleteTableCommand,
  waitUntilTableNotExists,
} from '@aws-sdk/client-dynamodb';

import { parseSchema } from '../../src/parser/index.js';
import { createDynamoClient, createDocClient } from '../../src/dynamo/client.js';
import { createTables } from '../../src/dynamo/table-creator.js';
import { createAuthEnforcer } from '../../src/auth/enforcer.js';
import { generateTokens } from '../../src/auth/token-manager.js';
import { createGraphQLServer } from '../../src/services/graphql/server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, '..', 'fixtures', 'minimal-amplify');
const DDB_PORT = process.env.AMPLIFY_LOCAL_DYNAMODB_PORT || '8000';
const DDB_ENDPOINT = `http://127.0.0.1:${DDB_PORT}`;
const API_KEY = 'integration-key-001';

let app;
let adminToken;
let userToken;
let dynamoClient;
let dataDir;

/**
 * Reset all tables listed in the fixture before the suite runs. Keeps a clean
 * slate even if a previous run left data behind.
 */
async function wipeFixtureTables(parsedSchema) {
  const list = await dynamoClient.send(new ListTablesCommand({}));
  const existing = new Set(list.TableNames || []);
  for (const name of Object.keys(parsedSchema.models)) {
    if (existing.has(name)) {
      await dynamoClient.send(new DeleteTableCommand({ TableName: name }));
      await waitUntilTableNotExists(
        { client: dynamoClient, maxWaitTime: 30 },
        { TableName: name }
      );
    }
  }
}

beforeAll(async () => {
  dynamoClient = createDynamoClient(DDB_ENDPOINT);

  // Fast-fail if DynamoDB Local isn't running — CI + local dev both need it.
  try {
    await dynamoClient.send(new ListTablesCommand({}));
  } catch (err) {
    throw new Error(
      `DynamoDB Local must be running at ${DDB_ENDPOINT} for integration tests.\n` +
        `  Start it with: npx amplify-local docker:start\n` +
        `  Original error: ${err.message}`
    );
  }

  const parsedSchema = await parseSchema(FIXTURE);
  await wipeFixtureTables(parsedSchema);
  const result = await createTables(parsedSchema, dynamoClient);
  if (result.failed.length > 0) {
    throw new Error(
      `Failed to create tables: ${result.failed.map((f) => `${f.table}: ${f.error}`).join('; ')}`
    );
  }

  dataDir = mkdtempSync(join(tmpdir(), 'amplify-local-integ-'));
  const tokens = await generateTokens(
    [
      { email: 'admin@test.local', sub: 'admin-001', groups: ['admins'] },
      { email: 'user@test.local', sub: 'user-001', groups: [] },
    ],
    {},
    dataDir
  );
  adminToken = tokens.tokens['admin@test.local'].idToken;
  userToken = tokens.tokens['user@test.local'].idToken;

  const docClient = createDocClient(DDB_ENDPOINT);
  const enforcer = createAuthEnforcer(parsedSchema.models);

  app = createGraphQLServer({
    config: { ports: { graphql: 4502 }, customResolvers: {} },
    parsedSchema,
    docClient,
    enforcer,
    apiKey: API_KEY,
  });
}, 60000);

afterAll(() => {
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

/**
 * Tiny helper: POST a GraphQL document with an auth header.
 */
async function gql(query, { variables, apiKey, bearer } = {}) {
  const req = request(app).post('/graphql').send({ query, variables });
  if (apiKey) req.set('x-api-key', apiKey);
  if (bearer) req.set('Authorization', `Bearer ${bearer}`);
  const res = await req;
  return res.body;
}

describe('GraphQL CRUD (integration)', () => {
  let categoryId;
  let productId;

  it('createCategory requires the admins group', async () => {
    const denied = await gql(
      'mutation { createCategory(input: { name: "Nope" }) { id } }',
      { bearer: userToken }
    );
    expect(denied.errors?.[0].message).toMatch(/no matching auth rule/i);

    const ok = await gql(
      'mutation { createCategory(input: { name: "Electronics", description: "Tech" }) { id name } }',
      { bearer: adminToken }
    );
    expect(ok.data.createCategory.name).toBe('Electronics');
    categoryId = ok.data.createCategory.id;
  });

  it('createProduct with categoryId succeeds for admin', async () => {
    const res = await gql(
      `mutation ($input: CreateProductInput!) {
         createProduct(input: $input) { id name price sku categoryId status }
       }`,
      {
        variables: {
          input: {
            name: 'Widget',
            price: 9.99,
            sku: 'WDG-1',
            categoryId,
            status: 'ACTIVE',
            inStock: true,
            tags: ['new'],
          },
        },
        bearer: adminToken,
      }
    );
    expect(res.errors).toBeUndefined();
    expect(res.data.createProduct).toMatchObject({
      name: 'Widget',
      sku: 'WDG-1',
      categoryId,
      status: 'ACTIVE',
    });
    productId = res.data.createProduct.id;
  });

  it('listProducts is readable via x-api-key (public apiKey read rule)', async () => {
    const res = await gql('{ listProducts { items { id name sku } } }', { apiKey: API_KEY });
    expect(res.errors).toBeUndefined();
    expect(res.data.listProducts.items.length).toBeGreaterThan(0);
  });

  it('listProducts with filter applies FilterExpression', async () => {
    const res = await gql(
      '{ listProducts(filter: { price: { gt: 5 } }) { items { id price } } }',
      { apiKey: API_KEY }
    );
    expect(res.data.listProducts.items.every((p) => p.price > 5)).toBe(true);
  });

  it('getProduct resolves belongsTo category via nested query', async () => {
    const res = await gql(
      `{ getProduct(id: "${productId}") { id name category { id name } } }`,
      { apiKey: API_KEY }
    );
    expect(res.errors).toBeUndefined();
    expect(res.data.getProduct.category).toEqual({ id: categoryId, name: 'Electronics' });
  });

  it('hasMany returns ModelConnection shape with items + nextToken', async () => {
    const res = await gql(
      `{ getCategory(id: "${categoryId}") {
           id name products { items { id name sku } nextToken }
         } }`,
      { apiKey: API_KEY }
    );
    expect(res.errors).toBeUndefined();
    const conn = res.data.getCategory.products;
    expect(conn).toHaveProperty('items');
    expect(conn).toHaveProperty('nextToken');
    expect(Array.isArray(conn.items)).toBe(true);
    expect(conn.items.some((p) => p.id === productId)).toBe(true);
  });

  it('GSI query listProductByCategoryId uses the index', async () => {
    const res = await gql(
      `{ listProductByCategoryId(categoryId: "${categoryId}") { items { id sku } } }`,
      { apiKey: API_KEY }
    );
    expect(res.errors).toBeUndefined();
    expect(res.data.listProductByCategoryId.items.some((p) => p.id === productId)).toBe(true);
  });

  it('named GSI listProductBySku uses the bySkuIndex', async () => {
    const res = await gql(
      '{ listProductBySku(sku: "WDG-1") { items { id name } } }',
      { apiKey: API_KEY }
    );
    expect(res.errors).toBeUndefined();
    expect(res.data.listProductBySku.items[0].name).toBe('Widget');
  });

  it('updateProduct persists the new price', async () => {
    const res = await gql(
      `mutation { updateProduct(input: { id: "${productId}", price: 14.99 }) { id price } }`,
      { bearer: adminToken }
    );
    expect(res.data.updateProduct.price).toBe(14.99);

    const refetch = await gql(
      `{ getProduct(id: "${productId}") { price } }`,
      { apiKey: API_KEY }
    );
    expect(refetch.data.getProduct.price).toBe(14.99);
  });

  it('deleteProduct returns the deleted id, subsequent get is null', async () => {
    const del = await gql(
      `mutation { deleteProduct(input: { id: "${productId}" }) { id } }`,
      { bearer: adminToken }
    );
    expect(del.data.deleteProduct.id).toBe(productId);

    const res = await gql(
      `{ getProduct(id: "${productId}") { id } }`,
      { apiKey: API_KEY }
    );
    expect(res.data.getProduct).toBeNull();
  });

  it('non-admin cannot delete a category', async () => {
    const res = await gql(
      `mutation { deleteCategory(input: { id: "${categoryId}" }) { id } }`,
      { bearer: userToken }
    );
    expect(res.errors?.[0].message).toMatch(/no matching auth rule/i);
  });

  it('API key cannot perform create mutation', async () => {
    const res = await gql(
      'mutation { createCategory(input: { name: "Blocked" }) { id } }',
      { apiKey: API_KEY }
    );
    expect(res.errors?.[0].message).toMatch(/no matching auth rule/i);
  });
});
