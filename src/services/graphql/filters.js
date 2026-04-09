/**
 * Convert a GraphQL filter object into DynamoDB FilterExpression,
 * ExpressionAttributeNames, and ExpressionAttributeValues.
 *
 * Supports: eq, ne, gt, lt, ge, le, contains, notContains, beginsWith, between
 * Combinators: and, or, not (nested)
 *
 * Returns null if the filter is empty/undefined.
 */
export function buildFilterExpression(filter) {
  if (!filter || Object.keys(filter).length === 0) return null;

  const state = { nameCounter: 0, valueCounter: 0 };
  const names = {};
  const values = {};

  const expression = buildNode(filter, names, values, state);
  if (!expression) return null;

  return {
    FilterExpression: expression,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
}

/**
 * Recursively build a filter expression node.
 */
function buildNode(filter, names, values, state) {
  const parts = [];

  for (const [key, val] of Object.entries(filter)) {
    if (val === undefined || val === null) continue;

    if (key === 'and') {
      const subParts = val
        .filter(Boolean)
        .map((sub) => buildNode(sub, names, values, state))
        .filter(Boolean);
      if (subParts.length > 0) {
        parts.push(`(${subParts.join(' AND ')})`);
      }
      continue;
    }

    if (key === 'or') {
      const subParts = val
        .filter(Boolean)
        .map((sub) => buildNode(sub, names, values, state))
        .filter(Boolean);
      if (subParts.length > 0) {
        parts.push(`(${subParts.join(' OR ')})`);
      }
      continue;
    }

    if (key === 'not') {
      const inner = buildNode(val, names, values, state);
      if (inner) {
        parts.push(`NOT (${inner})`);
      }
      continue;
    }

    // key is a field name, val is an object with comparison operators
    if (typeof val !== 'object') continue;

    const fieldAlias = `#f${state.nameCounter++}`;
    names[fieldAlias] = key;

    const fieldParts = buildFieldComparisons(fieldAlias, val, values, state);
    if (fieldParts.length > 0) {
      parts.push(...fieldParts);
    }
  }

  if (parts.length === 0) return null;
  return parts.join(' AND ');
}

/**
 * Build comparison expressions for a single field.
 */
function buildFieldComparisons(fieldAlias, comparisons, values, state) {
  const parts = [];

  for (const [op, val] of Object.entries(comparisons)) {
    if (val === undefined || val === null) continue;

    const valueAlias = `:v${state.valueCounter++}`;

    switch (op) {
      case 'eq':
        values[valueAlias] = val;
        parts.push(`${fieldAlias} = ${valueAlias}`);
        break;

      case 'ne':
        values[valueAlias] = val;
        parts.push(`${fieldAlias} <> ${valueAlias}`);
        break;

      case 'gt':
        values[valueAlias] = val;
        parts.push(`${fieldAlias} > ${valueAlias}`);
        break;

      case 'lt':
        values[valueAlias] = val;
        parts.push(`${fieldAlias} < ${valueAlias}`);
        break;

      case 'ge':
        values[valueAlias] = val;
        parts.push(`${fieldAlias} >= ${valueAlias}`);
        break;

      case 'le':
        values[valueAlias] = val;
        parts.push(`${fieldAlias} <= ${valueAlias}`);
        break;

      case 'contains':
        values[valueAlias] = val;
        parts.push(`contains(${fieldAlias}, ${valueAlias})`);
        break;

      case 'notContains':
        values[valueAlias] = val;
        parts.push(`NOT contains(${fieldAlias}, ${valueAlias})`);
        break;

      case 'beginsWith':
        values[valueAlias] = val;
        parts.push(`begins_with(${fieldAlias}, ${valueAlias})`);
        break;

      case 'between': {
        if (!Array.isArray(val) || val.length !== 2) break;
        const lowAlias = valueAlias;
        const highAlias = `:v${state.valueCounter++}`;
        values[lowAlias] = val[0];
        values[highAlias] = val[1];
        parts.push(`${fieldAlias} BETWEEN ${lowAlias} AND ${highAlias}`);
        break;
      }

      default:
        // Unknown operator — skip
        break;
    }
  }

  return parts;
}
