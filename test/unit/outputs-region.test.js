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
    expect(outputs.auth.identity_pool_id.startsWith('local-1:')).toBe(true);
  });
});
