/**
 * Extract models, scalar fields, relationship fields, and enum fields
 * from the raw Amplify schema object.
 *
 * Runtime object structure (discovered via inspection):
 * - Scalar fields: model.data.fields.{name}.data.fieldType = 'String'|'ID'|etc
 * - Relationship fields: model.data.fields.{name}.data.fieldType = 'model'
 *     + relatedModel, type ('belongsTo'|'hasMany'), references
 * - Enum fields: model.data.fields.{name}.type = 'enum', .values = [...]
 *     (no .data wrapper — different shape from scalars/relationships)
 */
export function extractModels(schema) {
  const models = {};

  if (!schema.models) {
    return models;
  }

  for (const [modelName, model] of Object.entries(schema.models)) {
    const dataFields = model.data?.fields || {};
    const fields = {};
    const relationships = {};
    const enums = {};

    for (const [fieldName, field] of Object.entries(dataFields)) {
      // Enum fields have a different shape: { type: 'enum', values: [...] }
      if (field.type === 'enum' && field.values) {
        enums[fieldName] = field.values;
        continue;
      }

      const fd = field.data;
      if (!fd) continue;

      // Relationship fields have fieldType === 'model'
      if (fd.fieldType === 'model') {
        relationships[fieldName] = {
          type: fd.type, // 'belongsTo' | 'hasMany' | 'hasOne'
          model: fd.relatedModel,
          references: fd.references || [],
        };
        continue;
      }

      // Scalar fields
      fields[fieldName] = {
        type: fd.fieldType,
        required: fd.required ?? false,
        array: fd.array ?? false,
        arrayRequired: fd.arrayRequired ?? false,
        default: fd.default ?? undefined,
      };
    }

    models[modelName] = { fields, relationships, enums };
  }

  return models;
}
