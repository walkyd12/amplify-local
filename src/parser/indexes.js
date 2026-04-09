/**
 * Extract primary key and secondary indexes from a model.
 *
 * - Primary key: model.data.identifier (array of field names, usually ['id'])
 * - Secondary indexes: model.data.secondaryIndexes array, each with:
 *     .data.partitionKey, .data.sortKeys, .data.indexName, .data.queryField
 */
export function extractIndexes(model) {
  // Primary key
  const primaryKey = model.data?.identifier || ['id'];

  // Secondary indexes
  const secondaryIndexes = [];
  const rawIndexes = model.data?.secondaryIndexes || [];

  for (const idx of rawIndexes) {
    const data = idx.data || idx;

    const partitionKey = data.partitionKey;
    if (!partitionKey) continue;

    // Generate a default index name if not provided
    const sortKeys = data.sortKeys || [];
    const indexName =
      data.indexName ||
      generateIndexName(partitionKey, sortKeys);

    secondaryIndexes.push({
      partitionKey,
      sortKeys,
      indexName,
      queryField: data.queryField || '',
      projectionType: data.projectionType || 'ALL',
    });
  }

  return { primaryKey, secondaryIndexes };
}

/**
 * Generate a default GSI name from partition and sort keys.
 * e.g., partitionKey='storeId', sortKeys=['createdAt'] -> 'byStoreIdAndCreatedAt'
 */
function generateIndexName(partitionKey, sortKeys) {
  const parts = [capitalize(partitionKey)];
  for (const sk of sortKeys) {
    parts.push(capitalize(sk));
  }
  return 'by' + parts.join('And');
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
