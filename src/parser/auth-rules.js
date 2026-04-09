/**
 * Extract auth rules from a model's authorization array.
 *
 * Auth rules are stored behind Symbol(data) on each authorization entry.
 * Access via Object.getOwnPropertySymbols(rule) to find Symbol(data),
 * then rule[symbol] to get:
 *   { strategy, provider, operations, groups, groupOrOwnerField, multiOwner }
 */
export function extractAuthRules(model) {
  const authArray = model.data?.authorization || [];
  const rules = [];

  for (const rule of authArray) {
    const data = getSymbolData(rule);
    if (!data) continue;

    // When no operations are specified, the rule allows all operations
    const operations =
      data.operations && data.operations.length > 0
        ? data.operations
        : ['create', 'read', 'update', 'delete'];

    rules.push({
      strategy: data.strategy,
      provider: data.provider || inferProvider(data.strategy),
      operations,
      groups: data.groups || undefined,
      groupOrOwnerField: data.groupOrOwnerField || undefined,
      multiOwner: data.multiOwner || false,
    });
  }

  return rules;
}

/**
 * Infer the default provider when not explicitly set.
 */
function inferProvider(strategy) {
  switch (strategy) {
    case 'public':
      return 'apiKey';
    case 'private':
      return 'userPools';
    case 'groups':
      return 'userPools';
    case 'owner':
      return 'userPools';
    default:
      return undefined;
  }
}

/**
 * Extract data from the Symbol(data) property.
 */
function getSymbolData(obj) {
  if (!obj || typeof obj !== 'object') return null;

  const symbols = Object.getOwnPropertySymbols(obj);
  for (const sym of symbols) {
    if (sym.toString() === 'Symbol(data)') {
      return obj[sym];
    }
  }

  return null;
}
