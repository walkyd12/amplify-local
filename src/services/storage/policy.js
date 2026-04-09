/**
 * Storage access policy enforcement.
 *
 * Matches request paths against configured storage paths from the Amplify
 * storage definition and checks whether the auth level has permission
 * for the requested operation.
 *
 * Storage paths in Amplify Gen 2 look like:
 *   {
 *     'public/*': { guest: ['get', 'list'], authenticated: ['get', 'list', 'write', 'delete'] },
 *     'private/{entity_id}/*': { entityidentity: ['get', 'list', 'write', 'delete'] },
 *     'products/*': { groups: { admins: ['get', 'list', 'write', 'delete'], customers: ['get', 'list'] } },
 *   }
 */

/**
 * Check whether a storage operation is allowed for the given auth context.
 *
 * @param {string} path - The object key being accessed (e.g., "public/image.png")
 * @param {string} operation - 'get' | 'list' | 'write' | 'delete'
 * @param {object} authContext - From auth middleware ({ type, sub, groups, ... })
 * @param {object} storageConfig - Parsed storage config with .paths
 * @returns {{ allowed: boolean, reason: string }}
 */
export function checkStorageAccess(path, operation, authContext, storageConfig) {
  if (!storageConfig || !storageConfig.paths) {
    // No storage config = allow all
    return { allowed: true, reason: 'No storage policy configured' };
  }

  const paths = storageConfig.paths;

  // Find the best matching path rule
  const matchedRule = findMatchingRule(path, paths, authContext);
  if (!matchedRule) {
    return { allowed: false, reason: `No storage path rule matches: ${path}` };
  }

  const { rule, pathPattern } = matchedRule;

  // Determine allowed operations based on auth level
  const allowedOps = getAllowedOperations(rule, authContext);

  if (allowedOps.includes(operation)) {
    return { allowed: true, reason: `Allowed by path rule: ${pathPattern}` };
  }

  return {
    allowed: false,
    reason: `Operation '${operation}' not allowed on path '${pathPattern}' for auth level`,
  };
}

/**
 * Find the storage path rule that best matches the given object key.
 * Replaces {entity_id} with the user's sub for owner-scoped paths.
 */
function findMatchingRule(path, paths, authContext) {
  let bestMatch = null;
  let bestSpecificity = -1;

  for (const [pattern, rule] of Object.entries(paths)) {
    const specificity = matchPattern(path, pattern, authContext);
    if (specificity > bestSpecificity) {
      bestSpecificity = specificity;
      bestMatch = { rule, pathPattern: pattern };
    }
  }

  return bestMatch;
}

/**
 * Check if a path matches a pattern, returning a specificity score.
 * Returns -1 if no match, higher numbers for more specific matches.
 *
 * Patterns use:
 *   * → match any segment(s)
 *   {entity_id} → match the user's sub (or any value for matching purposes)
 */
function matchPattern(path, pattern, authContext) {
  // Normalize: remove trailing slashes
  const normPath = path.replace(/\/+$/, '');
  const normPattern = pattern.replace(/\/+$/, '');

  // Replace {entity_id} with actual sub for exact matching, or wildcard if no auth
  let regexStr = normPattern
    .replace(/\{entity_id\}/g, authContext?.sub ? escapeRegex(authContext.sub) : '[^/]+')
    .replace(/\*/g, '.*');

  const regex = new RegExp(`^${regexStr}$`);

  if (regex.test(normPath)) {
    // Specificity: longer patterns (without wildcards) are more specific
    return normPattern.replace(/\*/g, '').replace(/\{entity_id\}/g, '').length;
  }

  return -1;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Determine which operations are allowed for the given auth context under a path rule.
 */
function getAllowedOperations(rule, authContext) {
  const ops = [];

  // Guest access (unauthenticated / IAM / API key)
  if (rule.guest) {
    if (!authContext || authContext.type === 'iam' || authContext.type === 'apiKey') {
      ops.push(...rule.guest);
    }
    // Authenticated users also get guest permissions
    if (authContext?.type === 'userPool' && authContext.sub) {
      ops.push(...rule.guest);
    }
  }

  // Authenticated access (any valid token)
  if (rule.authenticated) {
    if (authContext?.type === 'userPool' && authContext.sub && !authContext.invalid) {
      ops.push(...rule.authenticated);
    }
  }

  // Entity identity access (owner-scoped paths like private/{entity_id}/*)
  if (rule.entityidentity) {
    if (authContext?.type === 'userPool' && authContext.sub && !authContext.invalid) {
      ops.push(...rule.entityidentity);
    }
  }

  // Group-based access
  if (rule.groups && typeof rule.groups === 'object') {
    const userGroups = authContext?.groups || [];
    for (const [group, groupOps] of Object.entries(rule.groups)) {
      if (userGroups.includes(group)) {
        ops.push(...groupOps);
      }
    }
  }

  // Deduplicate
  return [...new Set(ops)];
}
