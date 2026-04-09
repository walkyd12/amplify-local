import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { loadConfig } from './config.js';
import { parseSchema } from './parser/index.js';
import { writeOutputs } from './generator/outputs.js';
import { createDynamoClient, createDocClient } from './dynamo/client.js';
import { createTables } from './dynamo/table-creator.js';
import { seed, reset } from './dynamo/seeder.js';

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
      try {
        const config = await loadConfig(program.opts());
        const spinner = ora('Parsing schema...').start();

        const parsedSchema = await parseSchema(config.amplifyDir);
        const modelCount = Object.keys(parsedSchema.models).length;
        spinner.text = `Creating ${modelCount} tables...`;

        const endpoint = `http://localhost:${config.ports.dynamodb}`;
        const dynamoClient = createDynamoClient(endpoint);
        const result = await createTables(parsedSchema, dynamoClient, {
          reset: options.reset || false,
        });

        spinner.succeed('DynamoDB tables ready');
        console.log();

        if (result.created.length > 0) {
          console.log(chalk.green(`  Created: ${result.created.join(', ')}`));
        }
        if (result.skipped.length > 0) {
          console.log(chalk.yellow(`  Skipped (already exist): ${result.skipped.join(', ')}`));
        }
        if (result.failed.length > 0) {
          for (const f of result.failed) {
            console.log(chalk.red(`  Failed: ${f.table} — ${f.error}`));
          }
        }

        // Print GSI summary
        for (const [name, model] of Object.entries(parsedSchema.models)) {
          const gsiCount = (model.secondaryIndexes || []).length;
          if (gsiCount > 0) {
            const gsiNames = model.secondaryIndexes.map((i) => i.indexName).join(', ');
            console.log(`  ${name}: ${gsiCount} GSI(s) — ${gsiNames}`);
          }
        }
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
    .command('seed')
    .description('Seed DynamoDB tables with test data')
    .option('--file <path>', 'Path to seed data JSON file')
    .option('--reset', 'Clear all data before seeding')
    .action(async (options) => {
      try {
        const config = await loadConfig(program.opts());
        const endpoint = `http://localhost:${config.ports.dynamodb}`;

        if (options.reset) {
          const spinner = ora('Resetting tables...').start();
          const parsedSchema = await parseSchema(config.amplifyDir);
          const dynamoClient = createDynamoClient(endpoint);
          const resetResult = await reset(parsedSchema, dynamoClient);
          spinner.succeed('Tables reset');

          if (resetResult.created.length > 0) {
            console.log(chalk.green(`  Recreated: ${resetResult.created.join(', ')}`));
          }
        }

        const seedFile = options.file || config.seed;
        if (!seedFile) {
          if (!options.reset) {
            console.error(chalk.red('Error: No seed file specified. Use --file <path> or set seed in config.'));
            process.exit(1);
          }
          return;
        }

        const spinner = ora('Seeding data...').start();
        const parsedSchema = await parseSchema(config.amplifyDir);
        const docClient = createDocClient(endpoint);

        const { resolve } = await import('path');
        const resolvedFile = resolve(process.cwd(), seedFile);
        const result = await seed(resolvedFile, parsedSchema, docClient);
        spinner.succeed('Seed complete');

        console.log();
        for (const [model, count] of Object.entries(result.seeded)) {
          console.log(chalk.green(`  ${model}: ${count} items`));
        }
        for (const warning of result.warnings) {
          console.log(chalk.yellow(`  Warning: ${warning}`));
        }
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
