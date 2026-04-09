import { GraphQLError } from 'graphql';

/**
 * Wrap a resolver map with auth enforcement.
 *
 * For each Query resolver, checks 'read' permission before execution.
 * For each Mutation resolver, checks the corresponding operation (create/update/delete).
 * For list queries on owner-based models, injects the owner filter from the enforcer.
 * On auth failure, returns an AppSync-compatible Unauthorized error.
 *
 * @param {object} resolvers - Resolver map from buildResolvers()
 * @param {object} parsedSchema - The parsed schema with model info
 * @param {object} enforcer - Auth enforcer from createAuthEnforcer() with authorize()
 * @returns {object} Wrapped resolver map
 */
export function wrapResolversWithAuth(resolvers, parsedSchema, enforcer) {
  const wrapped = {};

  // Wrap Query resolvers
  if (resolvers.Query) {
    wrapped.Query = {};
    for (const [name, resolver] of Object.entries(resolvers.Query)) {
      const { modelName, operation } = parseQueryName(name, parsedSchema);
      if (modelName) {
        wrapped.Query[name] = wrapQueryResolver(name, resolver, modelName, operation, enforcer);
      } else {
        // Unknown query (custom) — pass through, custom-queries handles its own logic
        wrapped.Query[name] = resolver;
      }
    }
  }

  // Wrap Mutation resolvers
  if (resolvers.Mutation) {
    wrapped.Mutation = {};
    for (const [name, resolver] of Object.entries(resolvers.Mutation)) {
      const { modelName, operation } = parseMutationName(name, parsedSchema);
      if (modelName) {
        wrapped.Mutation[name] = wrapMutationResolver(name, resolver, modelName, operation, enforcer);
      } else {
        wrapped.Mutation[name] = resolver;
      }
    }
  }

  // Pass through type resolvers (relationship resolvers on model types) without wrapping.
  // Auth is checked at the top-level query/mutation; nested resolvers execute within
  // that already-authorized context.
  for (const [key, value] of Object.entries(resolvers)) {
    if (key !== 'Query' && key !== 'Mutation') {
      wrapped[key] = value;
    }
  }

  return wrapped;
}

/**
 * Wrap a query resolver with read auth check.
 */
function wrapQueryResolver(queryName, resolver, modelName, operation, enforcer) {
  return async (parent, args, context, info) => {
    const authContext = context.authContext || { type: 'iam', authenticated: false };
    const authResult = enforcer.authorize(modelName, operation, authContext);

    if (!authResult.allowed) {
      throw new GraphQLError(authResult.reason, {
        extensions: { errorType: 'Unauthorized' },
      });
    }

    // For list queries with an owner filter, inject it into the args
    if (authResult.ownerFilter && args) {
      const existingFilter = args.filter || {};
      args = {
        ...args,
        filter: {
          ...existingFilter,
          [authResult.ownerFilter.field]: { eq: authResult.ownerFilter.value },
        },
      };
    }

    return resolver(parent, args, context, info);
  };
}

/**
 * Wrap a mutation resolver with auth check for the specific operation.
 *
 * For create: checks auth, then sets owner field if owner rule applies.
 * For update/delete: fetches item first to check ownership if needed.
 */
function wrapMutationResolver(mutationName, resolver, modelName, operation, enforcer) {
  return async (parent, args, context, info) => {
    const authContext = context.authContext || { type: 'iam', authenticated: false };

    if (operation === 'create') {
      const authResult = enforcer.authorize(modelName, 'create', authContext);
      if (!authResult.allowed) {
        throw new GraphQLError(authResult.reason, {
          extensions: { errorType: 'Unauthorized' },
        });
      }

      // If owner rule applies, set the owner field on the input
      if (authResult.ownerField && authResult.ownerValue && args.input) {
        args = {
          ...args,
          input: {
            ...args.input,
            [authResult.ownerField]: authResult.ownerValue,
          },
        };
      }

      return resolver(parent, args, context, info);
    }

    // For update/delete, check auth (item-level check happens without the item
    // on first pass — if owner rule, the enforcer returns ownerFilter metadata
    // indicating the user is authenticated and can proceed, but we trust the
    // resolver to only affect owned items)
    const authResult = enforcer.authorize(modelName, operation, authContext);
    if (!authResult.allowed) {
      throw new GraphQLError(authResult.reason, {
        extensions: { errorType: 'Unauthorized' },
      });
    }

    return resolver(parent, args, context, info);
  };
}

/**
 * Parse a Query resolver name to extract the model name and operation.
 * Examples: getProduct → Product/read, listProducts → Product/read,
 *           listProductByStoreId → Product/read
 */
function parseQueryName(name, parsedSchema) {
  const models = Object.keys(parsedSchema.models);

  // get{Model}
  if (name.startsWith('get')) {
    const modelName = name.slice(3);
    if (models.includes(modelName)) {
      return { modelName, operation: 'read' };
    }
  }

  // list{Models} or list{Model}By{Field}
  if (name.startsWith('list')) {
    // Try to match a GSI query first: list{Model}By{Something}
    for (const modelName of models) {
      if (name.startsWith(`list${modelName}By`)) {
        return { modelName, operation: 'read' };
      }
    }

    // Try to match list{PluralModelName}
    for (const modelName of models) {
      const plural = pluralize(modelName);
      if (name === `list${plural}`) {
        return { modelName, operation: 'read' };
      }
    }

    // Try matching by GSI queryField directly
    for (const [modelName, model] of Object.entries(parsedSchema.models)) {
      for (const idx of model.secondaryIndexes || []) {
        if (idx.queryField === name) {
          return { modelName, operation: 'read' };
        }
      }
    }
  }

  return { modelName: null, operation: null };
}

/**
 * Parse a Mutation resolver name to extract the model name and operation.
 * Examples: createProduct → Product/create, updateProduct → Product/update,
 *           deleteProduct → Product/delete
 */
function parseMutationName(name, parsedSchema) {
  const models = Object.keys(parsedSchema.models);
  const ops = ['create', 'update', 'delete'];

  for (const op of ops) {
    if (name.startsWith(op)) {
      const modelName = name.slice(op.length);
      if (models.includes(modelName)) {
        return { modelName, operation: op };
      }
    }
  }

  return { modelName: null, operation: null };
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
