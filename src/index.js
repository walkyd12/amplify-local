/**
 * Programmatic entry point for amplify-local.
 *
 * The primary interface is the CLI (`bin/amplify-local.js`). These
 * re-exports let consumers embed amplify-local inside their own scripts
 * or test harnesses — e.g. to spin up the stack from a global
 * vitest `setup` or a CI fixture.
 */

export { loadConfig } from './config.js';
export { parseSchema } from './parser/index.js';
export { startAll, stopAll, checkStatus } from './orchestrator.js';
export { dockerStart, dockerStop } from './docker.js';
export { generateOutputs, writeOutputs } from './generator/outputs.js';
export { buildIntrospection } from './generator/introspection.js';
export { createDynamoClient, createDocClient } from './dynamo/client.js';
export { createTables } from './dynamo/table-creator.js';
export { seed, reset } from './dynamo/seeder.js';
export { generateTokens } from './auth/token-manager.js';
export { createAuthEnforcer } from './auth/enforcer.js';
export { installSkill } from './skill-installer.js';
export {
  log,
  info,
  warn,
  error,
  getEntries,
  subscribe,
  configureLogger,
  interceptConsole,
} from './logger.js';
