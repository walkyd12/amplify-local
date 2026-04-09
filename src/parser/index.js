import { importSchema } from './importer.js';
import { extractModels } from './models.js';

/**
 * Parse an Amplify Gen 2 backend definition and return a structured schema.
 * This is the main entry point for the parser.
 */
export async function parseSchema(amplifyDir) {
  // 1. Import the TypeScript definitions
  const { data, schema } = await importSchema(amplifyDir);

  // 2. Extract models, fields, and relationships
  const models = extractModels(schema);

  // Return partial parsed schema (auth rules, indexes, enums added in Task 3)
  return {
    models,
    raw: { data, schema },
  };
}
