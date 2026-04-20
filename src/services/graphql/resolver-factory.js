import { randomUUID } from 'node:crypto';
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  ScanCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { buildFilterExpression } from './filters.js';

/**
 * Build a complete resolver map for all models in the parsed schema.
 *
 * @param {object} parsedSchema - Output of parseSchema()
 * @param {DynamoDBDocumentClient} docClient - DynamoDB document client
 * @returns {object} Resolver map compatible with makeExecutableSchema
 */
export function buildResolvers(parsedSchema, docClient) {
  const Query = {};
  const Mutation = {};
  const typeResolvers = {};

  for (const [modelName, model] of Object.entries(parsedSchema.models)) {
    // get query
    Query[`get${modelName}`] = createGetResolver(modelName, docClient);

    // list query
    const pluralName = pluralize(modelName);
    Query[`list${pluralName}`] = createListResolver(modelName, docClient);

    // GSI queries
    for (const idx of model.secondaryIndexes || []) {
      const queryName = idx.queryField || `list${modelName}By${capitalize(idx.partitionKey)}`;
      Query[queryName] = createGSIQueryResolver(modelName, idx, docClient);
    }

    // Mutations
    Mutation[`create${modelName}`] = createCreateResolver(modelName, model, docClient);
    Mutation[`update${modelName}`] = createUpdateResolver(modelName, docClient);
    Mutation[`delete${modelName}`] = createDeleteResolver(modelName, docClient);

    // Nested relationship resolvers
    const nestedResolvers = buildRelationshipResolvers(modelName, model, parsedSchema, docClient);
    if (Object.keys(nestedResolvers).length > 0) {
      typeResolvers[modelName] = nestedResolvers;
    }
  }

  return {
    Query,
    Mutation,
    ...typeResolvers,
  };
}

/**
 * get resolver: GetCommand by primary key (id).
 */
function createGetResolver(modelName, docClient) {
  return async (_parent, args) => {
    const result = await docClient.send(
      new GetCommand({
        TableName: modelName,
        Key: { id: args.id },
      })
    );
    return result.Item || null;
  };
}

/**
 * list resolver: ScanCommand with optional filter, limit, and pagination.
 */
function createListResolver(modelName, docClient) {
  return async (_parent, args) => {
    const { filter, limit, nextToken } = args || {};

    const params = { TableName: modelName };

    // Apply filter
    const filterExpr = buildFilterExpression(filter);
    if (filterExpr) {
      params.FilterExpression = filterExpr.FilterExpression;
      params.ExpressionAttributeNames = {
        ...params.ExpressionAttributeNames,
        ...filterExpr.ExpressionAttributeNames,
      };
      params.ExpressionAttributeValues = {
        ...params.ExpressionAttributeValues,
        ...filterExpr.ExpressionAttributeValues,
      };
    }

    // Pagination
    if (limit) {
      params.Limit = limit;
    }
    if (nextToken) {
      try {
        params.ExclusiveStartKey = JSON.parse(
          Buffer.from(nextToken, 'base64').toString('utf8')
        );
      } catch {
        // Invalid nextToken — ignore
      }
    }

    const result = await docClient.send(new ScanCommand(params));

    return {
      items: result.Items || [],
      nextToken: result.LastEvaluatedKey
        ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
        : null,
    };
  };
}

/**
 * GSI query resolver: QueryCommand on an index.
 */
function createGSIQueryResolver(modelName, index, docClient) {
  return async (_parent, args) => {
    const { filter, limit, nextToken } = args;

    const partitionValue = args[index.partitionKey];

    // Key condition expression
    let keyCondition = '#pk = :pkval';
    const exprNames = { '#pk': index.partitionKey };
    const exprValues = { ':pkval': partitionValue };

    // Sort key condition (if provided in args)
    for (const sk of index.sortKeys || []) {
      if (args[sk] !== undefined && args[sk] !== null) {
        keyCondition += ' AND #sk = :skval';
        exprNames['#sk'] = sk;
        exprValues[':skval'] = args[sk];
      }
    }

    const params = {
      TableName: modelName,
      IndexName: index.indexName,
      KeyConditionExpression: keyCondition,
      ExpressionAttributeNames: exprNames,
      ExpressionAttributeValues: exprValues,
    };

    // Apply additional filter
    const filterExpr = buildFilterExpression(filter);
    if (filterExpr) {
      params.FilterExpression = filterExpr.FilterExpression;
      Object.assign(params.ExpressionAttributeNames, filterExpr.ExpressionAttributeNames);
      Object.assign(params.ExpressionAttributeValues, filterExpr.ExpressionAttributeValues);
    }

    if (limit) {
      params.Limit = limit;
    }
    if (nextToken) {
      try {
        params.ExclusiveStartKey = JSON.parse(
          Buffer.from(nextToken, 'base64').toString('utf8')
        );
      } catch {
        // Invalid nextToken — ignore
      }
    }

    const result = await docClient.send(new QueryCommand(params));

    return {
      items: result.Items || [],
      nextToken: result.LastEvaluatedKey
        ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
        : null,
    };
  };
}

/**
 * create mutation: PutCommand with auto-generated id and timestamps.
 */
function createCreateResolver(modelName, model, docClient) {
  return async (_parent, { input }) => {
    const now = new Date().toISOString();
    const item = {
      id: randomUUID(),
      ...input,
      createdAt: now,
      updatedAt: now,
    };

    await docClient.send(
      new PutCommand({
        TableName: modelName,
        Item: item,
      })
    );

    return item;
  };
}

/**
 * update mutation: UpdateCommand building SET expression from provided fields.
 * Auto-sets updatedAt.
 */
function createUpdateResolver(modelName, docClient) {
  return async (_parent, { input }) => {
    const { id, ...fields } = input;
    fields.updatedAt = new Date().toISOString();

    const setExpressions = [];
    const exprNames = {};
    const exprValues = {};
    let counter = 0;

    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      const nameAlias = `#u${counter}`;
      const valueAlias = `:u${counter}`;
      exprNames[nameAlias] = key;
      exprValues[valueAlias] = value;
      setExpressions.push(`${nameAlias} = ${valueAlias}`);
      counter++;
    }

    if (setExpressions.length === 0) {
      // Nothing to update — just fetch and return
      const existing = await docClient.send(
        new GetCommand({ TableName: modelName, Key: { id } })
      );
      return existing.Item || null;
    }

    const result = await docClient.send(
      new UpdateCommand({
        TableName: modelName,
        Key: { id },
        UpdateExpression: `SET ${setExpressions.join(', ')}`,
        ExpressionAttributeNames: exprNames,
        ExpressionAttributeValues: exprValues,
        ReturnValues: 'ALL_NEW',
      })
    );

    return result.Attributes || null;
  };
}

/**
 * delete mutation: DeleteCommand returning the deleted item.
 */
function createDeleteResolver(modelName, docClient) {
  return async (_parent, { input }) => {
    const result = await docClient.send(
      new DeleteCommand({
        TableName: modelName,
        Key: { id: input.id },
        ReturnValues: 'ALL_OLD',
      })
    );

    return result.Attributes || null;
  };
}

/**
 * Build nested relationship resolvers for a model.
 *
 * - belongsTo: GetCommand using the foreign key value on the parent item
 * - hasMany: QueryCommand on the related table's GSI
 */
function buildRelationshipResolvers(modelName, model, parsedSchema, docClient) {
  const resolvers = {};

  for (const [fieldName, rel] of Object.entries(model.relationships || {})) {
    if (rel.type === 'belongsTo') {
      resolvers[fieldName] = createBelongsToResolver(rel, docClient);
    } else if (rel.type === 'hasMany') {
      resolvers[fieldName] = createHasManyResolver(rel, parsedSchema, docClient);
    } else if (rel.type === 'hasOne') {
      resolvers[fieldName] = createHasOneResolver(rel, parsedSchema, docClient);
    }
  }

  return resolvers;
}

/**
 * belongsTo resolver: fetch the related item using the FK on the parent.
 *
 * The references array contains the FK field names on this model (e.g., ['categoryId']).
 * We use the first reference as the FK field.
 */
function createBelongsToResolver(rel, docClient) {
  return async (parent) => {
    const fkField = rel.references[0];
    const fkValue = parent[fkField];
    if (!fkValue) return null;

    const result = await docClient.send(
      new GetCommand({
        TableName: rel.model,
        Key: { id: fkValue },
      })
    );

    return result.Item || null;
  };
}

/**
 * Fetch children of a parent across a relationship. Used by both hasMany
 * (returned as a connection) and hasOne (first item returned).
 */
async function fetchRelatedItems(rel, parent, parsedSchema, docClient) {
  const relatedModel = parsedSchema.models[rel.model];
  if (!relatedModel) return [];

  const fkField = rel.references[0];
  const fkValue = parent.id;
  if (!fkValue) return [];

  const gsi = (relatedModel.secondaryIndexes || []).find(
    (idx) => idx.partitionKey === fkField
  );

  if (gsi) {
    const result = await docClient.send(
      new QueryCommand({
        TableName: rel.model,
        IndexName: gsi.indexName,
        KeyConditionExpression: '#fk = :fkval',
        ExpressionAttributeNames: { '#fk': fkField },
        ExpressionAttributeValues: { ':fkval': fkValue },
      })
    );
    return result.Items || [];
  }

  const filterExpr = buildFilterExpression({ [fkField]: { eq: fkValue } });
  const params = { TableName: rel.model };
  if (filterExpr) {
    params.FilterExpression = filterExpr.FilterExpression;
    params.ExpressionAttributeNames = filterExpr.ExpressionAttributeNames;
    params.ExpressionAttributeValues = filterExpr.ExpressionAttributeValues;
  }

  const result = await docClient.send(new ScanCommand(params));
  return result.Items || [];
}

/**
 * hasMany resolver: returns a ModelXConnection { items, nextToken } to match
 * the Amplify-generated schema shape.
 */
function createHasManyResolver(rel, parsedSchema, docClient) {
  return async (parent) => {
    const items = await fetchRelatedItems(rel, parent, parsedSchema, docClient);
    return { items, nextToken: null };
  };
}

/**
 * hasOne resolver: returns the first related item, or null.
 */
function createHasOneResolver(rel, parsedSchema, docClient) {
  return async (parent) => {
    const items = await fetchRelatedItems(rel, parent, parsedSchema, docClient);
    return items[0] || null;
  };
}

function capitalize(str) {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function pluralize(name) {
  if (!name) return name;
  const irregulars = {
    Person: 'People', Child: 'Children', Mouse: 'Mice',
    Goose: 'Geese', Man: 'Men', Woman: 'Women',
    Foot: 'Feet', Tooth: 'Teeth',
  };
  if (irregulars[name]) return irregulars[name];
  if (/[^aeiou]y$/i.test(name)) return name.slice(0, -1) + 'ies';
  if (/(?:s|x|z|sh|ch)$/i.test(name)) return name + 'es';
  return name + 's';
}
