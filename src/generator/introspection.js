/**
 * Build the model_introspection section of amplify_outputs.json
 * from the parsed schema.
 *
 * The introspection format matches what the Amplify client SDK expects
 * when calling Amplify.configure(outputs).
 */
export function buildIntrospection(parsedSchema) {
  const models = {};
  const enums = {};

  for (const [modelName, modelData] of Object.entries(parsedSchema.models)) {
    models[modelName] = buildModelEntry(modelName, modelData, parsedSchema);
  }

  for (const [enumName, values] of Object.entries(parsedSchema.enums)) {
    enums[enumName] = { name: enumName, values };
  }

  return {
    version: 1,
    models,
    enums,
    nonModels: {},
  };
}

/**
 * Build a single model's introspection entry.
 */
function buildModelEntry(modelName, modelData, parsedSchema) {
  const fields = {};

  // Auto-add 'id' if not present in parsed fields
  if (!modelData.fields.id) {
    fields.id = {
      name: 'id',
      isArray: false,
      type: 'ID',
      isRequired: true,
      attributes: [],
    };
  }

  // Scalar fields
  for (const [fieldName, fieldInfo] of Object.entries(modelData.fields)) {
    fields[fieldName] = {
      name: fieldName,
      isArray: fieldInfo.array,
      type: fieldInfo.type,
      isRequired: fieldInfo.required,
      attributes: [],
    };
    if (fieldName === 'createdAt' || fieldName === 'updatedAt') {
      fields[fieldName].isReadOnly = true;
    }
  }

  // Enum fields (stored separately in parsed schema)
  for (const [fieldName, values] of Object.entries(modelData.enums)) {
    const enumName = resolveEnumName(parsedSchema.enums, values, modelName, fieldName);
    fields[fieldName] = {
      name: fieldName,
      isArray: false,
      type: { enum: enumName },
      isRequired: false,
      attributes: [],
    };
  }

  // Relationship fields
  for (const [fieldName, relInfo] of Object.entries(modelData.relationships)) {
    fields[fieldName] = {
      name: fieldName,
      isArray: relInfo.type === 'hasMany',
      type: { model: relInfo.model },
      isRequired: false,
      attributes: [],
      association: buildAssociation(relInfo),
    };
  }

  // Auto-add timestamps if not already present
  if (!fields.createdAt) {
    fields.createdAt = {
      name: 'createdAt',
      isArray: false,
      type: 'AWSDateTime',
      isRequired: false,
      attributes: [],
      isReadOnly: true,
    };
  }
  if (!fields.updatedAt) {
    fields.updatedAt = {
      name: 'updatedAt',
      isArray: false,
      type: 'AWSDateTime',
      isRequired: false,
      attributes: [],
      isReadOnly: true,
    };
  }

  return {
    name: modelName,
    fields,
    syncable: true,
    pluralName: pluralize(modelName),
    attributes: buildModelAttributes(modelData),
    primaryKeyInfo: buildPrimaryKeyInfo(modelData.primaryKey),
  };
}

/**
 * Build the association object for a relationship field.
 */
function buildAssociation(relInfo) {
  switch (relInfo.type) {
    case 'belongsTo':
      return {
        connectionType: 'BELONGS_TO',
        targetNames: relInfo.references,
      };
    case 'hasMany':
      return {
        connectionType: 'HAS_MANY',
        associatedWith: relInfo.references,
      };
    case 'hasOne':
      return {
        connectionType: 'HAS_ONE',
        associatedWith: relInfo.references,
      };
    default:
      return {};
  }
}

/**
 * Build the attributes array for a model (model config, keys, auth rules).
 */
function buildModelAttributes(modelData) {
  const attributes = [];

  // Model marker
  attributes.push({ type: 'model', properties: {} });

  // Primary key
  attributes.push({
    type: 'key',
    properties: {
      fields: modelData.primaryKey || ['id'],
    },
  });

  // Secondary indexes (GSIs)
  for (const idx of modelData.secondaryIndexes || []) {
    const keyFields = [idx.partitionKey, ...(idx.sortKeys || [])];
    const props = { name: idx.indexName, fields: keyFields };
    if (idx.queryField) {
      props.queryField = idx.queryField;
    }
    attributes.push({ type: 'key', properties: props });
  }

  // Auth rules
  if (modelData.authorization && modelData.authorization.length > 0) {
    attributes.push({
      type: 'auth',
      properties: {
        rules: modelData.authorization.map(mapAuthRule),
      },
    });
  }

  return attributes;
}

/**
 * Map a parsed auth rule to the introspection auth rule format.
 */
function mapAuthRule(rule) {
  const mapped = {
    allow: rule.strategy,
    provider: rule.provider,
    operations: rule.operations,
  };
  if (rule.groups) {
    mapped.groups = rule.groups;
  }
  if (rule.groupOrOwnerField) {
    mapped.ownerField = rule.groupOrOwnerField;
  }
  return mapped;
}

/**
 * Build primaryKeyInfo for a model.
 */
function buildPrimaryKeyInfo(primaryKey) {
  const pk = primaryKey || ['id'];
  return {
    isCustomPrimaryKey: pk.length > 1 || pk[0] !== 'id',
    primaryKeyFieldName: pk[0],
    sortKeyFieldNames: pk.slice(1),
  };
}

/**
 * Find the top-level enum name that matches the given values,
 * or generate a name from model + field.
 */
function resolveEnumName(topEnums, values, modelName, fieldName) {
  for (const [name, enumValues] of Object.entries(topEnums)) {
    if (
      Array.isArray(enumValues) &&
      enumValues.length === values.length &&
      enumValues.every((v, i) => v === values[i])
    ) {
      return name;
    }
  }
  // Fallback: generate name matching the convention in enums.js
  return modelName + fieldName.charAt(0).toUpperCase() + fieldName.slice(1);
}

/**
 * Naive English pluralization for model names.
 */
function pluralize(name) {
  if (!name) return name;

  // Common irregular plurals
  const irregulars = {
    Person: 'People',
    Child: 'Children',
    Mouse: 'Mice',
    Goose: 'Geese',
    Man: 'Men',
    Woman: 'Women',
    Foot: 'Feet',
    Tooth: 'Teeth',
  };
  if (irregulars[name]) return irregulars[name];

  // Ends in 'y' preceded by a consonant -> 'ies'
  if (/[^aeiou]y$/i.test(name)) {
    return name.slice(0, -1) + 'ies';
  }

  // Ends in sibilant -> 'es'
  if (/(?:s|x|z|sh|ch)$/i.test(name)) {
    return name + 'es';
  }

  return name + 's';
}
