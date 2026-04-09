import { importSchema, importAuthConfig, importStorageConfig } from './importer.js';
import { extractModels } from './models.js';
import { extractAuthRules } from './auth-rules.js';
import { extractIndexes } from './indexes.js';
import { extractEnums } from './enums.js';

/**
 * Parse an Amplify Gen 2 backend definition and return a complete structured schema.
 *
 * Returns:
 * {
 *   models: {
 *     [name]: {
 *       fields, relationships, enums,
 *       authorization, primaryKey, secondaryIndexes
 *     }
 *   },
 *   enums: { [name]: [values] },
 *   authorizationModes: { defaultAuthorizationMode, ... },
 *   authConfig: { groups, ... } | null,
 *   storageConfig: { paths, ... } | null,
 * }
 */
export async function parseSchema(amplifyDir) {
  // 1. Import the TypeScript definitions
  const { data, schema } = await importSchema(amplifyDir);

  // 2. Extract models, fields, and relationships
  const models = extractModels(schema);

  // 3. Add auth rules and indexes to each model
  const modelEnums = {};
  for (const [modelName, modelData] of Object.entries(models)) {
    const rawModel = schema.models[modelName];

    // Auth rules from Symbol(data)
    modelData.authorization = extractAuthRules(rawModel);

    // Primary key and secondary indexes
    const { primaryKey, secondaryIndexes } = extractIndexes(rawModel);
    modelData.primaryKey = primaryKey;
    modelData.secondaryIndexes = secondaryIndexes;

    // Collect inline enums for top-level enum extraction
    if (Object.keys(modelData.enums).length > 0) {
      modelEnums[modelName] = modelData.enums;
    }
  }

  // 4. Extract top-level enums (deduplicated with inline enums)
  const enums = extractEnums(schema, modelEnums);

  // 5. Extract authorization modes from data.props
  const authorizationModes = data.props?.authorizationModes || {
    defaultAuthorizationMode: 'apiKey',
  };

  // 6. Import auth config (graceful if missing)
  let authConfig = null;
  try {
    const authResource = await importAuthConfig(amplifyDir);
    if (authResource) {
      authConfig = extractAuthResourceConfig(authResource);
    }
  } catch {
    // Auth resource not found or failed to import — that's fine
  }

  // 7. Import storage config (graceful if missing)
  let storageConfig = null;
  try {
    const storageResource = await importStorageConfig(amplifyDir);
    if (storageResource) {
      storageConfig = extractStorageResourceConfig(storageResource);
    }
  } catch {
    // Storage resource not found or failed to import — that's fine
  }

  return {
    models,
    enums,
    authorizationModes,
    authConfig,
    storageConfig,
  };
}

/**
 * Extract useful config from the auth resource object.
 */
function extractAuthResourceConfig(authResource) {
  try {
    const props = authResource.props || authResource;
    return {
      groups: props.groups || [],
      loginWith: props.loginWith || {},
      // Password policy and other config would be extracted here
    };
  } catch {
    return null;
  }
}

/**
 * Extract useful config from the storage resource object.
 */
function extractStorageResourceConfig(storageResource) {
  try {
    const props = storageResource.props || storageResource;
    return {
      paths: props.access || {},
      bucketName: props.name || 'amplify-local-storage',
    };
  } catch {
    return null;
  }
}
