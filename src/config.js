import { existsSync } from 'fs';
import { resolve, join } from 'path';
import { pathToFileURL } from 'url';

const DEFAULTS = {
  amplifyDir: './amplify',
  output: './amplify_outputs.json',
  // Host embedded into amplify_outputs.json for the GraphQL + REST URLs.
  // Override to the server's LAN IP / hostname when consumers access the
  // emulator from another machine (e.g. `publicHost: '192.168.50.3'`).
  // Cognito URLs are NOT rewritten because they must match the
  // SDK-derived `https://cognito-idp.<aws_region>.amazonaws.com/` pattern —
  // use the hosts-file + TLS setup instead.
  publicHost: 'localhost',
  // Explicit URL overrides. Use these when the emulator lives behind an
  // HTTPS reverse proxy (required when the consuming app itself runs over
  // https — browsers block http fetches from https pages). Each key, when
  // set, replaces the URL amplify_outputs.json would otherwise compose
  // from `publicHost` + the service port.
  //   urls: {
  //     graphql: 'https://graphql.local-1.amazonaws.com/graphql',
  //     rest:    'https://rest.local-1.amazonaws.com',  // appended: /<endpointKey>/
  //   }
  urls: {},
  // Enable emitting `identity_pool_id` + `unauthenticated_identities_enabled`
  // in amplify_outputs.json. amplify-local does NOT emulate the Cognito
  // Identity Pool endpoint, so leaving this on causes the Amplify SDK to
  // hit `cognito-identity.<region>.amazonaws.com` and stall with
  // `ERR_NAME_NOT_RESOLVED`. Off by default; flip on only if you plan to
  // run your own identity-pool stub.
  emitIdentityPool: false,
  ports: {
    graphql: 4502,
    storage: 4503,
    rest: 4504,
    dashboard: 4501,
    cognito: 4500,
    dynamodb: 8000,
  },
  users: [],
  rest: {},
  seed: null,
  storageBackend: 'filesystem',
  storageDir: './.amplify-local/storage',
  dynamodbPersist: true,
  dynamodbDataDir: './.amplify-local/dynamodb-data',
  customResolvers: {},
};

/**
 * Load and merge configuration from defaults, config file, and CLI options.
 * Priority: CLI flags > config file > defaults
 */
export async function loadConfig(cliOptions = {}) {
  const cwd = process.cwd();

  // 1. Try to load config file
  let fileConfig = {};
  const configPath = cliOptions.config
    ? resolve(cwd, cliOptions.config)
    : resolve(cwd, 'amplify-local.config.js');

  if (existsSync(configPath)) {
    try {
      const configUrl = pathToFileURL(configPath).href;
      const mod = await import(configUrl);
      fileConfig = mod.default || mod;
    } catch (err) {
      throw new Error(
        `Failed to load config file at ${configPath}: ${err.message}`
      );
    }
  } else if (cliOptions.config) {
    // Only error if user explicitly specified a config path that doesn't exist
    throw new Error(`Config file not found: ${configPath}`);
  }

  // 2. Merge: defaults < file config < CLI options
  const merged = {
    ...DEFAULTS,
    ...fileConfig,
    ports: {
      ...DEFAULTS.ports,
      ...(fileConfig.ports || {}),
    },
    urls: {
      ...DEFAULTS.urls,
      ...(fileConfig.urls || {}),
    },
  };

  // Apply CLI overrides
  if (cliOptions.amplifyDir) {
    merged.amplifyDir = cliOptions.amplifyDir;
  }
  if (cliOptions.out) {
    merged.output = cliOptions.out;
  }

  // 3. Resolve amplify directory
  merged.amplifyDir = resolve(cwd, merged.amplifyDir);

  if (!existsSync(merged.amplifyDir)) {
    throw new Error(
      `Amplify directory not found: ${merged.amplifyDir}\n` +
        `  Expected an amplify/ directory with Gen 2 backend definitions.\n` +
        `  Use --amplify-dir to specify a custom path, or run from your project root.`
    );
  }

  // 4. Resolve other paths
  merged.output = resolve(cwd, merged.output);
  merged.storageDir = resolve(cwd, merged.storageDir);
  merged.dynamodbDataDir = resolve(cwd, merged.dynamodbDataDir);
  if (merged.seed) {
    merged.seed = resolve(cwd, merged.seed);
  }

  // 5. Apply env var overrides for ports
  if (process.env.AMPLIFY_LOCAL_GRAPHQL_PORT) {
    merged.ports.graphql = parseInt(process.env.AMPLIFY_LOCAL_GRAPHQL_PORT, 10);
  }
  if (process.env.AMPLIFY_LOCAL_STORAGE_PORT) {
    merged.ports.storage = parseInt(process.env.AMPLIFY_LOCAL_STORAGE_PORT, 10);
  }
  if (process.env.AMPLIFY_LOCAL_REST_PORT) {
    merged.ports.rest = parseInt(process.env.AMPLIFY_LOCAL_REST_PORT, 10);
  }
  if (process.env.AMPLIFY_LOCAL_DYNAMODB_PORT) {
    merged.ports.dynamodb = parseInt(process.env.AMPLIFY_LOCAL_DYNAMODB_PORT, 10);
  }
  if (process.env.AMPLIFY_LOCAL_DASHBOARD_PORT) {
    merged.ports.dashboard = parseInt(process.env.AMPLIFY_LOCAL_DASHBOARD_PORT, 10);
  }
  if (process.env.AMPLIFY_LOCAL_COGNITO_PORT) {
    merged.ports.cognito = parseInt(process.env.AMPLIFY_LOCAL_COGNITO_PORT, 10);
  }
  if (process.env.AMPLIFY_LOCAL_PUBLIC_HOST) {
    merged.publicHost = process.env.AMPLIFY_LOCAL_PUBLIC_HOST;
  }
  if (process.env.AMPLIFY_LOCAL_GRAPHQL_URL) {
    merged.urls.graphql = process.env.AMPLIFY_LOCAL_GRAPHQL_URL;
  }
  if (process.env.AMPLIFY_LOCAL_REST_URL) {
    merged.urls.rest = process.env.AMPLIFY_LOCAL_REST_URL;
  }
  if (process.env.AMPLIFY_LOCAL_EMIT_IDENTITY_POOL === 'true') {
    merged.emitIdentityPool = true;
  }

  return merged;
}
