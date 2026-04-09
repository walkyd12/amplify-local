import {
  CreateTableCommand,
  DeleteTableCommand,
  ListTablesCommand,
  DescribeTableCommand,
  waitUntilTableNotExists,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';

/**
 * Map Amplify/GraphQL field types to DynamoDB attribute types.
 * ID, String, AWSDateTime, AWSJSON, enums → S (String)
 * Int, Float → N (Number)
 */
function dynamoType(fieldType) {
  switch (fieldType) {
    case 'Int':
    case 'Float':
      return 'N';
    default:
      // ID, String, Boolean, AWSDateTime, AWSJSON, enum types → S
      return 'S';
  }
}

/**
 * Look up the DynamoDB attribute type for a key field by searching
 * the model's fields and enums.
 */
function getKeyAttributeType(model, fieldName) {
  // Check scalar fields
  const field = model.fields[fieldName];
  if (field) {
    return dynamoType(field.type);
  }

  // Check enum fields (all enums are stored as strings)
  if (model.enums && model.enums[fieldName]) {
    return 'S';
  }

  // Default to S (covers id, createdAt, updatedAt, etc.)
  return 'S';
}

/**
 * Build the CreateTableCommand input for a single model.
 */
function buildTableInput(modelName, model) {
  const primaryKey = model.primaryKey || ['id'];

  // Build key schema and attribute definitions for the primary key
  const keySchema = [];
  const attributeDefinitions = new Map();

  // HASH key is the first element of primaryKey
  const hashKey = primaryKey[0];
  keySchema.push({ AttributeName: hashKey, KeyType: 'HASH' });
  attributeDefinitions.set(hashKey, {
    AttributeName: hashKey,
    AttributeType: getKeyAttributeType(model, hashKey),
  });

  // RANGE key is the second element if present (composite primary key)
  if (primaryKey.length > 1) {
    const rangeKey = primaryKey[1];
    keySchema.push({ AttributeName: rangeKey, KeyType: 'RANGE' });
    attributeDefinitions.set(rangeKey, {
      AttributeName: rangeKey,
      AttributeType: getKeyAttributeType(model, rangeKey),
    });
  }

  // Build GSIs
  const globalSecondaryIndexes = [];
  for (const idx of model.secondaryIndexes || []) {
    const gsiKeySchema = [];

    // Partition key
    gsiKeySchema.push({
      AttributeName: idx.partitionKey,
      KeyType: 'HASH',
    });
    if (!attributeDefinitions.has(idx.partitionKey)) {
      attributeDefinitions.set(idx.partitionKey, {
        AttributeName: idx.partitionKey,
        AttributeType: getKeyAttributeType(model, idx.partitionKey),
      });
    }

    // Sort key (first sort key only — DynamoDB supports one per index)
    if (idx.sortKeys && idx.sortKeys.length > 0) {
      const sortKey = idx.sortKeys[0];
      gsiKeySchema.push({
        AttributeName: sortKey,
        KeyType: 'RANGE',
      });
      if (!attributeDefinitions.has(sortKey)) {
        attributeDefinitions.set(sortKey, {
          AttributeName: sortKey,
          AttributeType: getKeyAttributeType(model, sortKey),
        });
      }
    }

    globalSecondaryIndexes.push({
      IndexName: idx.indexName,
      KeySchema: gsiKeySchema,
      Projection: { ProjectionType: 'ALL' },
    });
  }

  const input = {
    TableName: modelName,
    KeySchema: keySchema,
    AttributeDefinitions: Array.from(attributeDefinitions.values()),
    BillingMode: 'PAY_PER_REQUEST',
  };

  if (globalSecondaryIndexes.length > 0) {
    input.GlobalSecondaryIndexes = globalSecondaryIndexes;
  }

  return input;
}

/**
 * Create DynamoDB tables for all models in the parsed schema.
 *
 * @param {object} parsedSchema - Output of parseSchema()
 * @param {DynamoDBClient} dynamoClient - DynamoDB client
 * @param {object} [options]
 * @param {boolean} [options.reset=false] - Drop and recreate existing tables
 * @returns {{ created: string[], skipped: string[], failed: { table: string, error: string }[] }}
 */
export async function createTables(parsedSchema, dynamoClient, options = {}) {
  const { reset = false } = options;

  const result = { created: [], skipped: [], failed: [] };

  // Get existing tables
  let existingTables = new Set();
  try {
    const response = await dynamoClient.send(new ListTablesCommand({}));
    existingTables = new Set(response.TableNames || []);
  } catch (err) {
    throw new Error(
      `Cannot connect to DynamoDB Local: ${err.message}\n\n` +
        `  Make sure DynamoDB Local is running. You can start it with:\n` +
        `    docker run -p 8000:8000 amazon/dynamodb-local\n\n` +
        `  Or use Docker Compose:\n` +
        `    amplify-local docker:start`
    );
  }

  for (const [modelName, model] of Object.entries(parsedSchema.models)) {
    try {
      // Handle reset: delete existing table first
      if (reset && existingTables.has(modelName)) {
        await dynamoClient.send(
          new DeleteTableCommand({ TableName: modelName })
        );
        await waitUntilTableNotExists(
          { client: dynamoClient, maxWaitTime: 30 },
          { TableName: modelName }
        );
      }

      // Skip if table already exists and not resetting
      if (!reset && existingTables.has(modelName)) {
        result.skipped.push(modelName);
        continue;
      }

      // Create the table
      const tableInput = buildTableInput(modelName, model);
      await dynamoClient.send(new CreateTableCommand(tableInput));

      // Wait for table to become active
      await waitUntilTableExists(
        { client: dynamoClient, maxWaitTime: 30 },
        { TableName: modelName }
      );

      result.created.push(modelName);
    } catch (err) {
      // ResourceInUseException means table already exists (race condition)
      if (err.name === 'ResourceInUseException') {
        result.skipped.push(modelName);
      } else {
        result.failed.push({ table: modelName, error: err.message });
      }
    }
  }

  return result;
}
