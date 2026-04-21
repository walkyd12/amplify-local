import { describe, it, expect, beforeAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseSchema } from '../../src/parser/index.js';
import { generateOutputs } from '../../src/generator/outputs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, '..', 'fixtures', 'minimal-amplify');

describe('amplify_outputs.json auth region', () => {
  let outputs;

  beforeAll(async () => {
    const parsed = await parseSchema(FIXTURE);
    outputs = generateOutputs(parsed, {
      amplifyDir: FIXTURE,
      output: '/tmp/amplify_outputs.json',
      ports: { graphql: 4502, storage: 4503, rest: 4504, dashboard: 4501, cognito: 4500, dynamodb: 8000 },
    });
  });

  it('uses a fake region so hosts-file overrides do not hit real AWS', () => {
    // The Amplify SDK builds cognito-idp.<region>.amazonaws.com from this
    // value. A fake region means redirecting that hostname to localhost
    // cannot collide with real Cognito traffic (us-east-1, eu-west-1, etc.)
    // running on the same machine.
    expect(outputs.auth.aws_region).toBe('local-1');
    expect(outputs.auth.user_pool_id.startsWith('local-1_')).toBe(true);
  });

  it('omits identity-pool fields by default (amplify-local does not emulate cognito-identity)', () => {
    expect(outputs.auth.identity_pool_id).toBeUndefined();
    expect(outputs.auth.unauthenticated_identities_enabled).toBeUndefined();
  });

  it('emits identity-pool fields when opted in', async () => {
    const parsed = await parseSchema(FIXTURE);
    const opted = generateOutputs(parsed, {
      amplifyDir: FIXTURE,
      output: '/tmp/amplify_outputs.json',
      ports: { graphql: 4502, storage: 4503, rest: 4504, dashboard: 4501, cognito: 4500, dynamodb: 8000 },
      emitIdentityPool: true,
    });
    expect(opted.auth.identity_pool_id.startsWith('local-1:')).toBe(true);
    expect(opted.auth.unauthenticated_identities_enabled).toBe(true);
  });

  it('respects publicHost for graphql + rest URLs', async () => {
    const parsed = await parseSchema(FIXTURE);
    const hosted = generateOutputs(parsed, {
      amplifyDir: FIXTURE,
      output: '/tmp/amplify_outputs.json',
      ports: { graphql: 4502, storage: 4503, rest: 4504, dashboard: 4501, cognito: 4500, dynamodb: 8000 },
      publicHost: '192.168.50.3',
      rest: { ordersApi: { 'GET /': { status: 200, body: {} } } },
    });
    expect(hosted.data.url).toBe('http://192.168.50.3:4502/graphql');
    expect(hosted.custom.ordersApi.endpoint).toBe('http://192.168.50.3:4504/ordersApi/');
  });
});
