import chalk from 'chalk';
import ora from 'ora';
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { loadConfig } from './config.js';
import { parseSchema } from './parser/index.js';
import { writeOutputs } from './generator/outputs.js';
import { createDynamoClient, createDocClient } from './dynamo/client.js';
import { createTables } from './dynamo/table-creator.js';
import { generateTokens } from './auth/token-manager.js';
import { createAuthEnforcer } from './auth/enforcer.js';
import { createGraphQLServer } from './services/graphql/server.js';
import { createStorageServer } from './services/storage/server.js';
import { createRestServer } from './services/rest/server.js';
import { createDashboardServer } from './services/dashboard/server.js';
import { interceptConsole, info as logInfo } from './logger.js';

const STATE_FILE = '.amplify-local/state.json';

/**
 * Start all local emulated services.
 *
 * Flow:
 *   1. Load config + parse schema
 *   2. Generate auth tokens
 *   3. Create DynamoDB tables
 *   4. Start GraphQL server
 *   5. Start Storage server (unless disabled)
 *   6. Start REST server (unless disabled)
 *   7. Write amplify_outputs.json
 *   8. Write state file for stop/status commands
 *
 * @param {object} cliOptions - Options from commander (amplifyDir, verbose, config, etc.)
 * @param {object} commandOptions - Options from the start subcommand (storage, rest, ephemeral)
 * @returns {object} { servers, config, cleanup }
 */
export async function startAll(cliOptions, commandOptions = {}) {
  const servers = {};
  const httpServers = {};

  // Route console output into the ring buffer before anything else starts,
  // so the dashboard log tab picks up every startup message.
  interceptConsole();
  logInfo('orchestrator', 'amplify-local startup');

  // 1. Load config
  const spinner = ora('Loading configuration...').start();
  const config = await loadConfig(cliOptions);
  spinner.succeed('Configuration loaded');

  // 2. Parse schema
  spinner.start('Parsing Amplify schema...');
  const parsedSchema = await parseSchema(config.amplifyDir);
  const modelCount = Object.keys(parsedSchema.models).length;
  spinner.succeed(`Schema parsed — ${modelCount} model(s)`);

  // 3. Generate auth tokens
  spinner.start('Generating auth tokens...');
  const users = config.users || [];
  const dataDir = dirname(join(process.cwd(), STATE_FILE));
  const { apiKey, tokens } = await generateTokens(users, parsedSchema.authConfig, dataDir);
  spinner.succeed(`Auth ready — API key + ${Object.keys(tokens).length} user token(s)`);

  // 4. Setup DynamoDB tables
  spinner.start('Setting up DynamoDB tables...');
  const endpoint = `http://localhost:${config.ports.dynamodb}`;
  const dynamoClient = createDynamoClient(endpoint);
  const docClient = createDocClient(endpoint);

  try {
    const tableResult = await createTables(parsedSchema, dynamoClient, { reset: false });
    const created = tableResult.created.length;
    const skipped = tableResult.skipped.length;
    spinner.succeed(`DynamoDB tables ready — ${created} created, ${skipped} existing`);
  } catch (err) {
    spinner.warn(`DynamoDB table setup failed: ${err.message}`);
    console.log(chalk.yellow('  Ensure DynamoDB Local is running on port ' + config.ports.dynamodb));
    console.log(chalk.yellow('  Run: amplify-local docker:start'));
  }

  // 5. Start GraphQL server
  spinner.start('Starting GraphQL server...');
  const enforcer = createAuthEnforcer(parsedSchema.models);
  const graphqlApp = createGraphQLServer({
    config,
    parsedSchema,
    docClient,
    enforcer,
    apiKey,
  });
  httpServers.graphql = await listen(graphqlApp, config.ports.graphql);
  servers.graphql = { port: config.ports.graphql, url: `http://localhost:${config.ports.graphql}/graphql` };
  spinner.succeed(`GraphQL server on port ${config.ports.graphql}`);

  // 6. Start Storage server (unless --no-storage)
  if (commandOptions.storage !== false) {
    spinner.start('Starting Storage server...');
    const storageApp = createStorageServer(config, apiKey);
    httpServers.storage = await listen(storageApp, config.ports.storage);
    servers.storage = { port: config.ports.storage, url: `http://localhost:${config.ports.storage}` };
    spinner.succeed(`Storage server on port ${config.ports.storage}`);
  }

  // 7. Start REST server (unless --no-rest)
  if (commandOptions.rest !== false && config.rest && Object.keys(config.rest).length > 0) {
    spinner.start('Starting REST mock server...');
    const restApp = createRestServer(config);
    httpServers.rest = await listen(restApp, config.ports.rest);
    servers.rest = { port: config.ports.rest, url: `http://localhost:${config.ports.rest}` };
    spinner.succeed(`REST mock server on port ${config.ports.rest}`);
  }

  // 8. Start Dashboard server (unless --no-dashboard)
  if (commandOptions.dashboard !== false) {
    spinner.start('Starting Dashboard server...');
    const dashboardApp = createDashboardServer({
      config,
      parsedSchema,
      services: servers,
      apiKey,
      dynamoClient,
      docClient,
    });
    httpServers.dashboard = await listen(dashboardApp, config.ports.dashboard);
    servers.dashboard = {
      port: config.ports.dashboard,
      url: `http://localhost:${config.ports.dashboard}`,
    };
    spinner.succeed(`Dashboard on port ${config.ports.dashboard}`);
  }

  // 9. Write amplify_outputs.json
  spinner.start('Writing amplify_outputs.json...');
  const outputs = writeOutputs(parsedSchema, config);
  spinner.succeed(`Generated ${config.output}`);

  // 10. Write state file
  const state = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    services: servers,
    configPath: cliOptions.config || null,
  };
  writeState(state);

  // 11. Print summary
  printSummary(servers, tokens, apiKey, config);

  // Build cleanup function
  const cleanup = () => stopServers(httpServers);

  return { servers, httpServers, config, cleanup };
}

/**
 * Stop all running services by reading the state file and signaling the process,
 * or by directly closing passed-in servers.
 */
export async function stopAll() {
  const state = readState();
  if (!state) {
    console.log(chalk.yellow('No running amplify-local instance found.'));
    return;
  }

  const { pid, services } = state;

  // Check if the process is still alive
  if (pid && pid !== process.pid) {
    try {
      process.kill(pid, 0); // Test if process exists
      process.kill(pid, 'SIGTERM');
      console.log(chalk.green(`Sent shutdown signal to process ${pid}`));
    } catch {
      console.log(chalk.yellow(`Process ${pid} is no longer running.`));
    }
  }

  // Clean up state file
  removeState();

  // Print what was stopped
  const serviceNames = Object.keys(services || {});
  if (serviceNames.length > 0) {
    console.log(chalk.green(`Stopped: ${serviceNames.join(', ')}`));
  }
}

/**
 * Check the status of running services.
 */
export async function checkStatus() {
  const state = readState();
  if (!state) {
    console.log(chalk.yellow('No running amplify-local instance found.'));
    return;
  }

  const { pid, startedAt, services } = state;

  // Check if process is alive
  let alive = false;
  if (pid) {
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
  }

  console.log();
  console.log(chalk.bold('amplify-local status'));
  console.log(`  PID:        ${pid} ${alive ? chalk.green('(running)') : chalk.red('(dead)')}`);
  console.log(`  Started at: ${startedAt}`);
  console.log();

  if (!alive) {
    console.log(chalk.yellow('  Process is no longer running. Run `amplify-local stop` to clean up.'));
    return;
  }

  // Health check each service
  for (const [name, info] of Object.entries(services || {})) {
    const healthy = await healthCheck(info.url || `http://localhost:${info.port}`);
    const status = healthy ? chalk.green('healthy') : chalk.red('unreachable');
    console.log(`  ${name.padEnd(10)} :${info.port}  ${status}`);
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Listen on a port, returning a promise that resolves to the http.Server.
 */
function listen(app, port) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => resolve(server));
    server.on('error', reject);
  });
}

/**
 * Gracefully close all http servers.
 */
function stopServers(httpServers) {
  const promises = Object.entries(httpServers).map(
    ([name, server]) =>
      new Promise((resolve) => {
        server.close(() => resolve(name));
      })
  );
  return Promise.all(promises);
}

/**
 * HTTP health check — tries to connect to a URL.
 */
async function healthCheck(url) {
  try {
    const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(2000) });
    return response.ok || response.status < 500;
  } catch {
    return false;
  }
}

/**
 * Write the state file so stop/status can find running services.
 */
function writeState(state) {
  const statePath = join(process.cwd(), STATE_FILE);
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

/**
 * Read the state file. Returns null if not found.
 */
function readState() {
  const statePath = join(process.cwd(), STATE_FILE);
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Remove the state file.
 */
function removeState() {
  const statePath = join(process.cwd(), STATE_FILE);
  if (existsSync(statePath)) {
    unlinkSync(statePath);
  }
}

/**
 * Print a nice startup summary.
 */
function printSummary(servers, tokens, apiKey, config) {
  console.log();
  console.log(chalk.bold.green('  amplify-local is running'));
  console.log();

  for (const [name, info] of Object.entries(servers)) {
    console.log(`  ${chalk.cyan(name.padEnd(10))} ${info.url || `http://localhost:${info.port}`}`);
  }

  console.log();
  console.log(`  API Key:  ${chalk.yellow(apiKey)}`);

  const userEmails = Object.keys(tokens);
  if (userEmails.length > 0) {
    console.log(`  Users:    ${userEmails.join(', ')}`);
    console.log(`  Tokens:   .amplify-local/tokens.json`);
  }

  console.log(`  Outputs:  ${config.output}`);
  console.log();
  console.log(`  ${chalk.dim('Press Ctrl+C to stop all services')}`);
  console.log();
}
