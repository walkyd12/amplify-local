import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { createTables } from './table-creator.js';

/**
 * Seed DynamoDB tables with data from a JSON file.
 *
 * JSON format:
 *   {
 *     "Product": [
 *       { "name": "Apples", "price": 3.99 },
 *       { "id": "custom-id", "name": "Bananas", "price": 1.29 }
 *     ],
 *     "Category": [
 *       { "name": "Fruit" }
 *     ]
 *   }
 *
 * Auto-generates id, createdAt, updatedAt if missing.
 * Batch-writes in groups of 25 (DynamoDB limit).
 *
 * @param {string} filePath - Path to seed JSON file
 * @param {object} parsedSchema - Output of parseSchema()
 * @param {DynamoDBDocumentClient} docClient - DynamoDB document client
 * @returns {{ seeded: Record<string, number>, warnings: string[] }}
 */
export async function seed(filePath, parsedSchema, docClient) {
  const result = { seeded: {}, warnings: [] };

  // Read and parse the seed file
  let seedData;
  try {
    const raw = readFileSync(filePath, 'utf8');
    seedData = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to read seed file ${filePath}: ${err.message}`);
  }

  if (typeof seedData !== 'object' || Array.isArray(seedData)) {
    throw new Error('Seed file must be a JSON object keyed by model name');
  }

  const modelNames = Object.keys(parsedSchema.models);

  for (const [tableName, items] of Object.entries(seedData)) {
    // Warn on unknown model names
    if (!modelNames.includes(tableName)) {
      result.warnings.push(`Unknown model "${tableName}" — not in parsed schema, skipping`);
      continue;
    }

    if (!Array.isArray(items)) {
      result.warnings.push(`"${tableName}" value is not an array, skipping`);
      continue;
    }

    if (items.length === 0) {
      continue;
    }

    // Auto-generate missing fields
    const now = new Date().toISOString();
    const preparedItems = items.map((item) => ({
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      ...item, // User-provided values take precedence
    }));

    // Batch write in groups of 25
    const batches = chunkArray(preparedItems, 25);
    let seededCount = 0;

    for (const batch of batches) {
      const requestItems = {
        [tableName]: batch.map((item) => ({
          PutRequest: { Item: item },
        })),
      };

      try {
        const response = await docClient.send(
          new BatchWriteCommand({ RequestItems: requestItems })
        );

        // Handle unprocessed items (retry once)
        const unprocessed = response.UnprocessedItems?.[tableName];
        if (unprocessed && unprocessed.length > 0) {
          await docClient.send(
            new BatchWriteCommand({
              RequestItems: { [tableName]: unprocessed },
            })
          );
        }

        seededCount += batch.length;
      } catch (err) {
        result.warnings.push(`Failed to seed batch for "${tableName}": ${err.message}`);
      }
    }

    result.seeded[tableName] = seededCount;
  }

  return result;
}

/**
 * Reset all tables (drop + recreate) and optionally re-seed.
 *
 * @param {object} parsedSchema - Output of parseSchema()
 * @param {DynamoDBClient} dynamoClient - Raw DynamoDB client (not doc client)
 * @returns {{ created: string[], skipped: string[], failed: Array }}
 */
export async function reset(parsedSchema, dynamoClient) {
  return createTables(parsedSchema, dynamoClient, { reset: true });
}

/**
 * Split an array into chunks of a given size.
 */
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
