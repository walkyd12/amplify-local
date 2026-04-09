import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { loadConfig } from './config.js';
import { parseSchema } from './parser/index.js';
import { writeOutputs } from './generator/outputs.js';

export function run() {
  const program = new Command();

  program
    .name('amplify-local')
    .description('Local emulator for AWS Amplify Gen 2 backends')
    .version('0.1.0')
    .option('--amplify-dir <path>', 'Path to amplify/ directory')
    .option('--verbose', 'Enable verbose logging')
    .option('--config <path>', 'Path to amplify-local.config.js');

  program
    .command('start')
    .description('Start all local emulated services')
    .option('--no-storage', 'Disable storage emulator')
    .option('--no-rest', 'Disable REST mock server')
    .option('--ephemeral', 'Use in-memory DynamoDB (no persistence)')
    .action(async (options) => {
      console.log('start: not yet implemented');
    });

  program
    .command('stop')
    .description('Stop all running local services')
    .action(async () => {
      console.log('stop: not yet implemented');
    });

  program
    .command('generate')
    .description('Generate amplify_outputs.json from backend definitions')
    .option('--out <path>', 'Output file path')
    .action(async (options) => {
      try {
        const config = await loadConfig({ ...program.opts(), ...options });
        const spinner = ora('Parsing schema...').start();

        const parsedSchema = await parseSchema(config.amplifyDir);
        spinner.text = 'Generating amplify_outputs.json...';

        const outputs = writeOutputs(parsedSchema, config);
        spinner.succeed(`Generated ${config.output}`);

        const modelCount = Object.keys(outputs.data.model_introspection.models).length;
        const enumCount = Object.keys(outputs.data.model_introspection.enums).length;
        console.log();
        console.log(`  Models: ${modelCount}`);
        console.log(`  Enums:  ${enumCount}`);
        console.log(`  Auth:   ${outputs.data.default_authorization_type}`);
        if (outputs.storage) {
          console.log(`  Storage: ${outputs.storage.bucket_name}`);
        }
        console.log();
        console.log(`  Point your app at the local backend:`);
        console.log(`    export NEXT_PUBLIC_USE_LOCAL_BACKEND=true`);
        console.log();
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        if (program.opts().verbose) {
          console.error(err.stack);
        }
        process.exit(1);
      }
    });

  program
    .command('setup-tables')
    .description('Create DynamoDB tables from backend schema')
    .option('--reset', 'Drop and recreate all tables')
    .action(async (options) => {
      console.log('setup-tables: not yet implemented');
    });

  program
    .command('seed')
    .description('Seed DynamoDB tables with test data')
    .option('--file <path>', 'Path to seed data JSON file')
    .option('--reset', 'Clear all data before seeding')
    .action(async (options) => {
      console.log('seed: not yet implemented');
    });

  program
    .command('status')
    .description('Check health of running local services')
    .action(async () => {
      console.log('status: not yet implemented');
    });

  program
    .command('docker:start')
    .description('Start DynamoDB Local via Docker Compose')
    .action(async () => {
      console.log('docker:start: not yet implemented');
    });

  program
    .command('docker:stop')
    .description('Stop DynamoDB Local Docker container')
    .action(async () => {
      console.log('docker:stop: not yet implemented');
    });

  program.parse();
}
