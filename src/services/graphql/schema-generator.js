import { makeExecutableSchema } from '@graphql-tools/schema';

/**
 * Map Amplify/parsed field types to GraphQL scalar types.
 */
const SCALAR_MAP = {
  ID: 'ID',
  String: 'String',
  Int: 'Int',
  Float: 'Float',
  Boolean: 'Boolean',
  AWSDateTime: 'String',
  AWSJSON: 'String',
};

/**
 * Generate a complete executable GraphQL schema from a parsed Amplify schema.
 *
 * Returns { schema, sdl } where schema is a GraphQL executable schema
 * and sdl is the raw SDL string (useful for debugging).
 */
export function generateSchema(parsedSchema) {
  const sdl = generateSDL(parsedSchema);
  const schema = makeExecutableSchema({ typeDefs: sdl });
  return { schema, sdl };
}

/**
 * Generate the GraphQL SDL string from parsed schema.
 */
export function generateSDL(parsedSchema) {
  const lines = [];

  // 1. Scalar filter input types (StringFilterInput, IDFilterInput, etc.)
  lines.push(generateScalarFilterTypes(parsedSchema));

  // 2. Enum types
  for (const [enumName, values] of Object.entries(parsedSchema.enums || {})) {
    lines.push(`enum ${enumName} {`);
    for (const v of values) {
      lines.push(`  ${v}`);
    }
    lines.push('}');
    lines.push('');
  }

  // 3. Model types, connection types, input types, filter types
  const queryFields = [];
  const mutationFields = [];

  for (const [modelName, model] of Object.entries(parsedSchema.models)) {
    // Object type
    lines.push(...generateModelType(modelName, model, parsedSchema));
    lines.push('');

    // Connection type
    lines.push(`type ${modelName}Connection {`);
    lines.push(`  items: [${modelName}]!`);
    lines.push(`  nextToken: String`);
    lines.push('}');
    lines.push('');

    // Input types
    lines.push(...generateCreateInput(modelName, model, parsedSchema));
    lines.push('');
    lines.push(...generateUpdateInput(modelName, model, parsedSchema));
    lines.push('');
    lines.push(`input Delete${modelName}Input {`);
    lines.push('  id: ID!');
    lines.push('}');
    lines.push('');

    // Filter input type
    lines.push(...generateFilterInput(modelName, model, parsedSchema));
    lines.push('');

    // Query fields
    queryFields.push(`  get${modelName}(id: ID!): ${modelName}`);
    queryFields.push(
      `  list${pluralize(modelName)}(filter: ${modelName}FilterInput, limit: Int, nextToken: String): ${modelName}Connection`
    );

    // GSI query fields
    for (const idx of model.secondaryIndexes || []) {
      const queryName = idx.queryField || `list${modelName}By${capitalize(idx.partitionKey)}`;
      const partitionType = resolveFieldGraphQLType(idx.partitionKey, model, parsedSchema);

      let args = `${idx.partitionKey}: ${partitionType}!`;

      // Sort key arguments
      for (const sk of idx.sortKeys || []) {
        const skType = resolveFieldGraphQLType(sk, model, parsedSchema);
        args += `, ${sk}: ${skType}`;
      }

      args += `, filter: ${modelName}FilterInput, limit: Int, nextToken: String`;
      queryFields.push(`  ${queryName}(${args}): ${modelName}Connection`);
    }

    // Mutation fields
    mutationFields.push(`  create${modelName}(input: Create${modelName}Input!): ${modelName}`);
    mutationFields.push(`  update${modelName}(input: Update${modelName}Input!): ${modelName}`);
    mutationFields.push(`  delete${modelName}(input: Delete${modelName}Input!): ${modelName}`);
  }

  // Query type
  lines.push('type Query {');
  lines.push(...queryFields);
  lines.push('}');
  lines.push('');

  // Mutation type
  lines.push('type Mutation {');
  lines.push(...mutationFields);
  lines.push('}');

  return lines.join('\n');
}

/**
 * Generate the GraphQL object type for a model.
 */
function generateModelType(modelName, model, parsedSchema) {
  const lines = [`type ${modelName} {`];

  // id field (always present)
  if (!model.fields.id) {
    lines.push('  id: ID!');
  }

  // Scalar fields
  for (const [fieldName, field] of Object.entries(model.fields)) {
    const gqlType = graphqlType(field);
    const required = field.required ? '!' : '';

    if (field.array) {
      const arrayRequired = field.arrayRequired ? '!' : '';
      lines.push(`  ${fieldName}: [${gqlType}${required}]${arrayRequired}`);
    } else {
      lines.push(`  ${fieldName}: ${gqlType}${required}`);
    }
  }

  // Enum fields
  for (const [fieldName, values] of Object.entries(model.enums || {})) {
    const enumName = resolveEnumName(parsedSchema.enums, values, modelName, fieldName);
    lines.push(`  ${fieldName}: ${enumName}`);
  }

  // Relationship fields
  for (const [fieldName, rel] of Object.entries(model.relationships || {})) {
    if (rel.type === 'hasMany') {
      lines.push(`  ${fieldName}: ${rel.model}Connection`);
    } else {
      lines.push(`  ${fieldName}: ${rel.model}`);
    }
  }

  // Auto-add timestamps if not present
  if (!model.fields.createdAt) {
    lines.push('  createdAt: String');
  }
  if (!model.fields.updatedAt) {
    lines.push('  updatedAt: String');
  }

  lines.push('}');
  return lines;
}

/**
 * Generate CreateModelInput — required fields required, optional fields optional.
 * Omit id, createdAt, updatedAt, and relationship fields.
 */
function generateCreateInput(modelName, model, parsedSchema) {
  const lines = [`input Create${modelName}Input {`];

  for (const [fieldName, field] of Object.entries(model.fields)) {
    if (['id', 'createdAt', 'updatedAt'].includes(fieldName)) continue;
    const gqlType = graphqlType(field);
    const required = field.required ? '!' : '';

    if (field.array) {
      lines.push(`  ${fieldName}: [${gqlType}${required}]`);
    } else {
      lines.push(`  ${fieldName}: ${gqlType}${required}`);
    }
  }

  // Enum fields
  for (const [fieldName, values] of Object.entries(model.enums || {})) {
    const enumName = resolveEnumName(parsedSchema.enums, values, modelName, fieldName);
    lines.push(`  ${fieldName}: ${enumName}`);
  }

  lines.push('}');
  return lines;
}

/**
 * Generate UpdateModelInput — id required, everything else optional.
 */
function generateUpdateInput(modelName, model, parsedSchema) {
  const lines = [`input Update${modelName}Input {`];
  lines.push('  id: ID!');

  for (const [fieldName, field] of Object.entries(model.fields)) {
    if (['id', 'createdAt', 'updatedAt'].includes(fieldName)) continue;
    const gqlType = graphqlType(field);

    if (field.array) {
      lines.push(`  ${fieldName}: [${gqlType}]`);
    } else {
      lines.push(`  ${fieldName}: ${gqlType}`);
    }
  }

  // Enum fields
  for (const [fieldName, values] of Object.entries(model.enums || {})) {
    const enumName = resolveEnumName(parsedSchema.enums, values, modelName, fieldName);
    lines.push(`  ${fieldName}: ${enumName}`);
  }

  lines.push('}');
  return lines;
}

/**
 * Generate ModelFilterInput with comparison operators per scalar field.
 */
function generateFilterInput(modelName, model, parsedSchema) {
  const lines = [`input ${modelName}FilterInput {`];

  // Filter fields for each scalar
  for (const [fieldName, field] of Object.entries(model.fields)) {
    const baseType = graphqlType(field);
    lines.push(`  ${fieldName}: ${baseType}FilterInput`);
  }

  // Enum filter fields
  for (const [fieldName, values] of Object.entries(model.enums || {})) {
    const enumName = resolveEnumName(parsedSchema.enums, values, modelName, fieldName);
    lines.push(`  ${fieldName}: ${enumName}FilterInput`);
  }

  // Combinators
  lines.push(`  and: [${modelName}FilterInput]`);
  lines.push(`  or: [${modelName}FilterInput]`);
  lines.push(`  not: ${modelName}FilterInput`);

  lines.push('}');
  return lines;
}

/**
 * Generate scalar filter input types (StringFilterInput, IDFilterInput, etc.)
 * and enum filter input types used across all models.
 */
function generateScalarFilterTypes(parsedSchema) {
  const usedTypes = new Set();

  for (const [modelName, model] of Object.entries(parsedSchema.models)) {
    for (const field of Object.values(model.fields)) {
      usedTypes.add(graphqlType(field));
    }
    for (const [fieldName, values] of Object.entries(model.enums || {})) {
      usedTypes.add(resolveEnumName(parsedSchema.enums, values, modelName, fieldName));
    }
  }

  const lines = [];
  for (const typeName of usedTypes) {
    lines.push(`input ${typeName}FilterInput {`);
    lines.push(`  eq: ${typeName}`);
    lines.push(`  ne: ${typeName}`);
    lines.push(`  gt: ${typeName}`);
    lines.push(`  lt: ${typeName}`);
    lines.push(`  ge: ${typeName}`);
    lines.push(`  le: ${typeName}`);
    if (typeName === 'String' || typeName === 'ID') {
      lines.push(`  contains: ${typeName}`);
      lines.push(`  notContains: ${typeName}`);
      lines.push(`  beginsWith: ${typeName}`);
    }
    lines.push(`  between: [${typeName}]`);
    lines.push('}');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Get the GraphQL type string for a parsed field.
 */
function graphqlType(field) {
  return SCALAR_MAP[field.type] || field.type;
}

/**
 * Resolve the GraphQL type for a field by name (used for GSI query args).
 */
function resolveFieldGraphQLType(fieldName, model, parsedSchema) {
  const field = model.fields[fieldName];
  if (field) return graphqlType(field);

  if (model.enums && model.enums[fieldName]) {
    return resolveEnumName(parsedSchema.enums, model.enums[fieldName], '', fieldName);
  }

  if (fieldName === 'id' || fieldName.endsWith('Id')) return 'ID';
  return 'String';
}

/**
 * Find the top-level enum name matching the given values.
 */
function resolveEnumName(topEnums, values, modelName, fieldName) {
  for (const [name, enumValues] of Object.entries(topEnums || {})) {
    if (
      Array.isArray(enumValues) &&
      enumValues.length === values.length &&
      enumValues.every((v, i) => v === values[i])
    ) {
      return name;
    }
  }
  return modelName + capitalize(fieldName);
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
