import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * Create a DynamoDBClient configured for DynamoDB Local.
 * Uses dummy credentials since DynamoDB Local doesn't validate them.
 */
export function createDynamoClient(endpoint = 'http://localhost:8000') {
  return new DynamoDBClient({
    endpoint,
    region: 'us-east-1',
    credentials: {
      accessKeyId: 'local',
      secretAccessKey: 'local',
    },
  });
}

/**
 * Create a DynamoDBDocumentClient wrapping a DynamoDBClient.
 * Marshalls/unmarshalls DynamoDB attribute values automatically.
 */
export function createDocClient(endpoint = 'http://localhost:8000') {
  const client = createDynamoClient(endpoint);
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: {
      removeUndefinedValues: true,
    },
  });
}
