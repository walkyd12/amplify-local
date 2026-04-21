import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { buildIntrospection } from './introspection.js';

/**
 * Generate a complete amplify_outputs.json object from parsed schema and config.
 */
export function generateOutputs(parsedSchema, config) {
  const outputs = {
    version: '1.4',
  };

  // Auth section — always present with fake local pool IDs
  outputs.auth = buildAuthSection(parsedSchema, config);

  // Data section — GraphQL endpoint, API key, model introspection
  outputs.data = buildDataSection(parsedSchema, config);

  // Storage section — only if storage config was parsed
  if (parsedSchema.storageConfig) {
    outputs.storage = buildStorageSection(parsedSchema, config);
  }

  // Custom/REST section — only if REST endpoints configured
  if (config.rest && Object.keys(config.rest).length > 0) {
    outputs.custom = buildCustomSection(config);
  }

  return outputs;
}

/**
 * Generate the outputs object and write it to disk.
 */
export function writeOutputs(parsedSchema, config) {
  const outputs = generateOutputs(parsedSchema, config);

  mkdirSync(dirname(config.output), { recursive: true });
  writeFileSync(config.output, JSON.stringify(outputs, null, 2) + '\n');

  return outputs;
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

function buildAuthSection(parsedSchema, config) {
  // A fake region is intentional: the Amplify SDK constructs the Cognito
  // URL from this value (`https://cognito-idp.<region>.amazonaws.com/`).
  // Using a non-existent region (`local-1`) means a hosts-file override for
  // that hostname only redirects amplify-local traffic — real Cognito calls
  // on us-east-1 etc. still resolve normally.
  const section = {
    user_pool_id: 'local-1_localpool01',
    aws_region: 'local-1',
    user_pool_client_id: 'local-client-id-000000',
    mfa_configuration: 'NONE',
    mfa_methods: [],
    password_policy: {
      min_length: 8,
      require_lowercase: true,
      require_uppercase: true,
      require_numbers: true,
      require_symbols: true,
    },
    standard_required_attributes: ['email'],
    username_attributes: ['email'],
    user_verification_types: ['email'],
  };

  // Groups from parsed auth config
  const groups = parsedSchema.authConfig?.groups;
  if (Array.isArray(groups) && groups.length > 0) {
    section.groups = {};
    groups.forEach((group, index) => {
      section.groups[group] = { precedence: index };
    });
  }

  // Identity-pool fields are off by default: amplify-local does not emulate
  // the `cognito-identity` endpoint, and leaving them in the output makes
  // the Amplify SDK stall on `ERR_NAME_NOT_RESOLVED` during
  // `fetchAuthSession`. Opt in via `emitIdentityPool: true` only if you
  // front amplify-local with your own identity-pool stub.
  if (config?.emitIdentityPool) {
    section.identity_pool_id = 'local-1:local-identity-pool-amplify';
    section.unauthenticated_identities_enabled = true;
  }

  return section;
}

function buildDataSection(parsedSchema, config) {
  const introspection = buildIntrospection(parsedSchema);

  const defaultMode = mapAuthMode(
    parsedSchema.authorizationModes?.defaultAuthorizationMode || 'apiKey'
  );

  // Collect additional auth modes used across all model auth rules
  const additionalModes = new Set();
  for (const model of Object.values(parsedSchema.models)) {
    for (const rule of model.authorization || []) {
      const mode = mapAuthMode(rule.provider);
      if (mode !== defaultMode) {
        additionalModes.add(mode);
      }
    }
  }

  const host = config.publicHost || 'localhost';
  const section = {
    url: `http://${host}:${config.ports.graphql}/graphql`,
    aws_region: 'us-east-1',
    default_authorization_type: defaultMode,
    authorization_types: Array.from(additionalModes),
    model_introspection: introspection,
  };

  // Include API key when API_KEY auth is in use
  if (defaultMode === 'API_KEY' || additionalModes.has('API_KEY')) {
    section.api_key = 'local-api-key-000000';
  }

  return section;
}

function buildStorageSection(parsedSchema, config) {
  const sc = parsedSchema.storageConfig;
  const bucketName = sc.bucketName || 'amplify-local-storage';

  return {
    aws_region: 'us-east-1',
    bucket_name: bucketName,
    buckets: [
      {
        name: bucketName,
        bucket_name: bucketName,
        aws_region: 'us-east-1',
        paths: sc.paths || {},
      },
    ],
  };
}

function buildCustomSection(config) {
  const custom = {};
  const restPort = config.ports.rest;
  const host = config.publicHost || 'localhost';

  for (const endpointKey of Object.keys(config.rest)) {
    custom[endpointKey] = {
      endpoint: `http://${host}:${restPort}/${endpointKey}/`,
      region: 'us-east-1',
    };
  }

  return custom;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map Amplify auth provider names to the authorization type constants
 * used in amplify_outputs.json.
 */
function mapAuthMode(mode) {
  switch (mode) {
    case 'apiKey':
      return 'API_KEY';
    case 'userPools':
      return 'AMAZON_COGNITO_USER_POOLS';
    case 'identityPool':
      return 'AWS_IAM';
    case 'oidc':
      return 'OPENID_CONNECT';
    default:
      return mode;
  }
}
