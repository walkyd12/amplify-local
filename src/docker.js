import { execFile, execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import ora from 'ora';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPOSE_FILE = join(__dirname, '..', 'docker', 'docker-compose.yml');
const PROJECT_NAME = 'amplify-local';

/**
 * Check that docker and docker compose are available.
 * Throws if not found.
 */
function checkDocker() {
  try {
    execFileSync('docker', ['--version'], { stdio: 'pipe' });
  } catch {
    throw new Error(
      'Docker is not installed or not in PATH.\n' +
        '  Install Docker Desktop: https://docs.docker.com/get-docker/'
    );
  }

  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'pipe' });
  } catch {
    throw new Error(
      'Docker Compose V2 is not available.\n' +
        '  Ensure you have Docker Compose V2 (docker compose, not docker-compose).'
    );
  }
}

/**
 * Build the base docker compose args.
 */
function composeArgs() {
  return ['compose', '-f', COMPOSE_FILE, '-p', PROJECT_NAME];
}

/**
 * Build env vars to pass to docker compose.
 */
function composeEnv(config, options = {}) {
  const env = { ...process.env };
  const port = config?.ports?.dynamodb || 8000;
  env.DYNAMODB_PORT = String(port);

  if (options.ephemeral) {
    env.DYNAMODB_COMMAND = '-jar DynamoDBLocal.jar -sharedDb -inMemory';
  }

  return env;
}

/**
 * Run a docker compose command, returning a promise with stdout/stderr.
 */
function compose(args, env) {
  return new Promise((resolve, reject) => {
    const child = execFile('docker', [...composeArgs(), ...args], { env }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.trim() || stdout?.trim() || err.message;
        reject(new Error(msg));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/**
 * Wait until DynamoDB Local responds on its health endpoint.
 * Polls every second up to maxWait seconds.
 */
async function waitForHealthy(port, maxWait = 30) {
  const url = `http://127.0.0.1:${port}/`;
  const start = Date.now();

  while (Date.now() - start < maxWait * 1000) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-amz-json-1.0',
          'X-Amz-Target': 'DynamoDB_20120810.ListTables',
          Authorization:
            'AWS4-HMAC-SHA256 Credential=local/20200101/us-east-1/dynamodb/aws4_request',
        },
        body: '{}',
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * Start DynamoDB Local via Docker Compose.
 *
 * @param {object} config - Loaded amplify-local config (needs config.ports.dynamodb)
 * @param {object} options - { ephemeral: bool, verbose: bool }
 */
export async function dockerStart(config, options = {}) {
  checkDocker();

  const port = config?.ports?.dynamodb || 8000;
  const env = composeEnv(config, options);

  // Check if already running
  const spinner = ora('Checking container status...').start();
  try {
    const { stdout } = await compose(['ps', '--format', 'json', '-q'], env);
    if (stdout.trim()) {
      spinner.succeed(`DynamoDB Local is already running on port ${port}`);
      return;
    }
  } catch {
    // not running — continue
  }

  // Pull image if needed (first run)
  spinner.text = 'Starting DynamoDB Local...';
  await compose(['up', '-d'], env);

  // Verify healthy
  spinner.text = 'Waiting for DynamoDB Local to become healthy...';
  const healthy = await waitForHealthy(port);

  if (healthy) {
    spinner.succeed(`DynamoDB Local running on port ${port}`);
  } else {
    spinner.warn(`DynamoDB Local started but health check timed out on port ${port}`);
    console.log(chalk.yellow('  Container may still be starting. Check with: docker ps'));
  }

  if (options.ephemeral) {
    console.log(chalk.dim('  Running in ephemeral mode — data will not persist'));
  } else {
    console.log(chalk.dim('  Data persisted in Docker volume: amplify-local_dynamodb-data'));
  }
}

/**
 * Stop DynamoDB Local Docker container.
 *
 * @param {object} options - { removeVolumes: bool, verbose: bool }
 */
export async function dockerStop(options = {}) {
  checkDocker();

  const spinner = ora('Stopping DynamoDB Local...').start();

  const args = ['down'];
  if (options.removeVolumes) {
    args.push('-v');
  }

  try {
    await compose(args, process.env);
    spinner.succeed('DynamoDB Local stopped');
    if (options.removeVolumes) {
      console.log(chalk.dim('  Docker volume removed — all data deleted'));
    }
  } catch (err) {
    // If nothing was running, that's fine
    if (err.message.includes('not found') || err.message.includes('no such')) {
      spinner.succeed('DynamoDB Local is not running');
    } else {
      spinner.fail('Failed to stop DynamoDB Local');
      throw err;
    }
  }
}
