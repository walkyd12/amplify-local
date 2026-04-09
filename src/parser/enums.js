/**
 * Extract top-level and inline enum types from the schema.
 *
 * Enums can appear in two places:
 * 1. Inline on model fields: field.type === 'enum' && field.values
 *    (these are collected during model extraction and passed in)
 * 2. Top-level schema enums (less common in Amplify Gen 2)
 *
 * We deduplicate by matching value arrays.
 */
export function extractEnums(schema, modelEnums) {
  const enums = {};

  // Collect inline enums from models, generating a name from the field
  // The modelEnums map is: { modelName: { fieldName: ['VALUE1', 'VALUE2'] } }
  for (const [modelName, fields] of Object.entries(modelEnums)) {
    for (const [fieldName, values] of Object.entries(fields)) {
      // Generate enum name: ModelNameFieldName (e.g., ProductStatus)
      const enumName =
        modelName + fieldName.charAt(0).toUpperCase() + fieldName.slice(1);

      // Check if we already have an enum with the same values
      const existingName = findMatchingEnum(enums, values);
      if (existingName) {
        // Reuse existing enum, but note this field maps to it
        continue;
      }

      enums[enumName] = Array.isArray(values) ? values : values;
    }
  }

  return enums;
}

/**
 * Find an existing enum with the same set of values.
 */
function findMatchingEnum(enums, values) {
  if (!Array.isArray(values)) return null;

  for (const [name, existingValues] of Object.entries(enums)) {
    if (!Array.isArray(existingValues)) continue;
    if (
      existingValues.length === values.length &&
      existingValues.every((v, i) => v === values[i])
    ) {
      return name;
    }
  }

  return null;
}
