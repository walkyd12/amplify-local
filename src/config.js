import { existsSync } from 'fs';
import { resolve, join } from 'path';
import { pathToFileURL } from 'url';

const DEFAULTS = {
  amplifyDir: './amplify',
  output: './amplify_outputs.json',
  ports: {
    graphql: 4502,
    storage: 4503,
    rest: 4504,
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

  return merged;
}
