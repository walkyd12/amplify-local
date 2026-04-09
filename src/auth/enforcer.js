/**
 * Create an auth enforcer that evaluates model-level authorization rules.
 *
 * Returns an authorize() function that checks whether a given operation
 * is allowed based on the model's auth rules and the request's auth context.
 */
export function createAuthEnforcer(parsedModels) {
  /**
   * Evaluate authorization for a specific operation on a model.
   *
   * @param {string} modelName - The model to check
   * @param {string} operation - 'create' | 'read' | 'update' | 'delete'
   * @param {object} authContext - From the auth middleware (type, sub, email, groups, etc.)
   * @param {object} [item] - The existing item (for owner checks on update/delete)
   * @returns {{ allowed: boolean, reason: string, ownerFilter?: object }}
   */
  function authorize(modelName, operation, authContext, item) {
    const model = parsedModels[modelName];
    if (!model) {
      return { allowed: false, reason: `Unknown model: ${modelName}` };
    }

    const rules = model.authorization || [];
    if (rules.length === 0) {
      // No auth rules = allow all (same as Amplify default when no auth is configured)
      return { allowed: true, reason: 'No auth rules defined' };
    }

    // Evaluate each rule — first match wins
    for (const rule of rules) {
      if (!rule.operations.includes(operation)) {
        continue;
      }

      const result = evaluateRule(rule, authContext, item);
      if (result.allowed) {
        return result;
      }
    }

    return { allowed: false, reason: 'No matching auth rule' };
  }

  return { authorize };
}

/**
 * Evaluate a single auth rule against the auth context.
 */
function evaluateRule(rule, authContext, item) {
  switch (rule.strategy) {
    case 'public':
      return evaluatePublicRule(rule, authContext);
    case 'private':
      return evaluatePrivateRule(rule, authContext);
    case 'groups':
      return evaluateGroupsRule(rule, authContext);
    case 'owner':
      return evaluateOwnerRule(rule, authContext, item);
    default:
      return { allowed: false, reason: `Unknown strategy: ${rule.strategy}` };
  }
}

/**
 * Public strategy: allow based on provider.
 * - apiKey provider: allow if request has a valid API key
 * - identityPool (IAM): allow all (permissive locally)
 */
function evaluatePublicRule(rule, authContext) {
  if (rule.provider === 'apiKey') {
    if (authContext.type === 'apiKey' && authContext.valid !== false) {
      return { allowed: true, reason: 'Public API key access' };
    }
    return { allowed: false, reason: 'API key required' };
  }

  if (rule.provider === 'identityPool') {
    // IAM-based public access — permissive in local dev
    return { allowed: true, reason: 'Public IAM access' };
  }

  return { allowed: false, reason: `Unknown public provider: ${rule.provider}` };
}

/**
 * Private strategy: allow any authenticated user (valid JWT).
 */
function evaluatePrivateRule(rule, authContext) {
  if (authContext.type === 'userPool' && authContext.sub && !authContext.invalid) {
    return { allowed: true, reason: 'Authenticated user' };
  }
  return { allowed: false, reason: 'Authentication required' };
}

/**
 * Groups strategy: allow if user belongs to any of the rule's groups.
 */
function evaluateGroupsRule(rule, authContext) {
  if (authContext.type !== 'userPool' || !authContext.sub || authContext.invalid) {
    return { allowed: false, reason: 'Authentication required for group access' };
  }

  const userGroups = authContext.groups || [];
  const allowedGroups = rule.groups || [];

  const hasGroup = allowedGroups.some((g) => userGroups.includes(g));
  if (hasGroup) {
    return { allowed: true, reason: `Group match: ${allowedGroups.join(', ')}` };
  }

  return { allowed: false, reason: `Requires group: ${allowedGroups.join(', ')}` };
}

/**
 * Owner strategy: allow if user owns the item.
 *
 * For create: allow any authenticated user (owner field will be set).
 * For read/update/delete with a specific item: match owner field to sub.
 * For list without a specific item: return an ownerFilter for the resolver to inject.
 */
function evaluateOwnerRule(rule, authContext, item) {
  if (authContext.type !== 'userPool' || !authContext.sub || authContext.invalid) {
    return { allowed: false, reason: 'Authentication required for owner access' };
  }

  const ownerField = rule.groupOrOwnerField || 'owner';

  // For create: any authenticated user can create (they become the owner)
  // The resolver should set the owner field to authContext.sub
  if (!item) {
    return {
      allowed: true,
      reason: 'Owner access (new item or list)',
      ownerField,
      ownerValue: authContext.sub,
      ownerFilter: { field: ownerField, value: authContext.sub },
    };
  }

  // For read/update/delete with existing item: check ownership
  const itemOwner = item[ownerField];
  if (itemOwner === authContext.sub) {
    return { allowed: true, reason: 'Owner match' };
  }

  return { allowed: false, reason: 'Not the owner' };
}
