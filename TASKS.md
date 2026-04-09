# amplify-local — Claude Code Task List

Reference: AMPLIFY_LOCAL_PLAN.md for full architecture and design decisions.

Each task below is sized for a single Claude Code session. Work sequentially — each task assumes the previous ones are complete.

---

## Task 1: Package scaffold + CLI + config loader

**Context**: Fresh repo. Building an npm package called `amplify-local` — a CLI tool that reads Amplify Gen 2 TypeScript backend definitions and spins up local emulated services. ESM package (type: module), Node 18+.

**Build**:
- `package.json` with name `amplify-local`, type `module`, bin pointing to `bin/amplify-local.js`, engines `>=18`. Dependencies: `commander`, `chalk`, `ora`.
- `bin/amplify-local.js` — shebang entry, imports and runs `src/cli.js`
- `src/cli.js` — commander program with subcommands: `start`, `stop`, `generate`, `setup-tables`, `seed`, `status`, `docker:start`, `docker:stop`. Each prints "not yet implemented" for now. Global options: `--amplify-dir <path>`, `--verbose`, `--config <path>`.
- `src/config.js` — exports `loadConfig(cliOptions)`:
  - Finds `amplify/` directory (from `--amplify-dir` flag, or CWD)
  - Loads optional `amplify-local.config.js` from CWD if it exists
  - Merges defaults → config file → CLI flags (CLI wins)
  - Returns merged config object with defaults for ports (graphql: 4502, storage: 4503, rest: 4504, dynamodb: 8000), storageDir, output path, users array, etc.
  - Throws clear error if amplify directory not found
- `.gitignore` (node_modules, .amplify-local/, dist/), `.npmignore`, `LICENSE` (MIT)
- Minimal `README.md` placeholder

**Acceptance Criteria**:
- [ ] `node bin/amplify-local.js --help` shows all commands with descriptions
- [ ] `node bin/amplify-local.js generate --help` shows command-specific options
- [ ] `npm link` works and `amplify-local --help` runs
- [ ] `loadConfig({})` returns defaults when no config file exists
- [ ] `loadConfig({})` throws helpful error when amplify dir not found
- [ ] Config file overrides merge correctly with defaults

**Creates**: Working CLI skeleton + config loader. Next task builds the parser that config feeds into.

---

## Task 2: Schema parser — TS importer + model/field/relationship extraction

**Context**: Package scaffold exists from Task 1. This task builds the core parser that imports Amplify Gen 2 TypeScript backend definitions at runtime and extracts model/field/relationship information. The parser uses `tsx` to import `amplify/data/resource.ts` and navigates the runtime object tree.

**Key technical details** (discovered via runtime inspection):
- Import path: `amplify/data/resource.ts` exports `data`
- Schema lives at: `data.props.schema`
- Models at: `data.props.schema.models` (object keyed by model name)
- Scalar fields at: `model.data.fields` — each has `{ fieldType: 'String'|'ID'|'Int'|'Float'|'Boolean'|'AWSDateTime'|'AWSJSON', required: bool, array: bool, default: value }`
- Relationship fields at: `model.fields` where `field.data.fieldType === 'model'` — has `{ relatedModel: 'Store', type: 'belongsTo'|'hasMany', references: ['storeId'] }`
- Enum fields at: `model.fields` where field has `type: 'enum'` and `values: [...]`
- Some fields appear in both `model.data.fields` (scalar data) and `model.fields` (full including relationships)

**Build**:
- Add `tsx` as a dependency
- `src/parser/index.js` — orchestrator that calls all extractors and returns a unified parsed schema object
- `src/parser/importer.js` — uses `tsx` to import `amplify/data/resource.ts` from the configured amplify directory. Returns `data.props.schema`. Handle import errors (missing file, syntax errors, missing deps) with clear error messages.
- `src/parser/models.js` — `extractModels(schema)`:
  - Iterate `schema.models`
  - For each model, extract:
    - Scalar fields from `model.data.fields` with their fieldType, required, array, arrayRequired, default
    - Relationship fields from `model.fields` where `data.fieldType === 'model'` — extract relatedModel, type (belongsTo/hasMany), references array
    - Enum fields from `model.fields` where field has `type: 'enum'` — extract values array
  - Return normalized structure: `{ [modelName]: { fields: {...}, relationships: {...}, enums: {...} } }`
- Create a test fixture: `test/fixtures/minimal-amplify/data/resource.ts` — a minimal Amplify schema with 2-3 models, a belongsTo/hasMany relationship, an enum field, and various field types. This doesn't need to be a real Amplify project, just enough to test the parser. Use the actual `@aws-amplify/backend` package to define it so the runtime objects are real.

**Acceptance Criteria**:
- [ ] `importer.js` successfully imports a real Amplify data resource file and returns the schema object
- [ ] Scalar fields extracted with correct types (String, ID, Int, Float, Boolean, AWSDateTime, AWSJSON)
- [ ] Relationship fields extracted with relatedModel, type, and references
- [ ] Enum fields extracted with values array
- [ ] Required/optional/array flags preserved
- [ ] Default values preserved
- [ ] Clear error message when amplify/data/resource.ts not found
- [ ] Test fixture exists and parser works against it

**Creates**: Parsed model/field/relationship data. Next task adds auth rules, indexes, and enums extraction.

---

## Task 3: Schema parser — auth rules, indexes, enums, auth/storage config

**Context**: Parser from Task 2 can extract models and fields. This task adds the remaining extractors: auth rules (stored behind Symbols), secondary indexes, top-level enums, and auth/storage configuration.

**Key technical details**:
- Auth rules at: `model.data.authorization` — array of objects where actual data is behind `Symbol(data)`. Access via `Object.getOwnPropertySymbols(rule)` to find the symbol, then `rule[symbol]` to get `{ strategy: 'public'|'private'|'groups'|'owner', provider: 'identityPool'|'apiKey'|'userPools', operations: ['read','create','update','delete'], groups: ['admins']|undefined, groupOrOwnerField: string|undefined, multiOwner: bool }`
- Secondary indexes at: `model.data.secondaryIndexes` — array of `{ data: { partitionKey: string, sortKeys: string[], indexName: string, queryField: string } }`
- Primary key at: `model.data.identifier` — array of field names (usually `['id']`)
- Top-level enums may be at: `schema.data.types`
- Auth modes at: `data.props.authorizationModes` — `{ defaultAuthorizationMode: 'apiKey', apiKeyAuthorizationMode: { expiresInDays: 30 } }`
- Storage config: import `amplify/storage/resource.ts` if it exists, inspect for bucket paths and permissions
- Auth config: import `amplify/auth/resource.ts` if it exists, inspect for groups and password policy

**Build**:
- `src/parser/auth-rules.js` — `extractAuthRules(model)`:
  - Read `model.data.authorization` array
  - For each entry, use `Object.getOwnPropertySymbols()` to find the data symbol
  - Extract strategy, provider, operations, groups, groupOrOwnerField
  - Return array of normalized auth rule objects
- `src/parser/indexes.js` — `extractIndexes(model)`:
  - Read `model.data.secondaryIndexes`, extract partitionKey, sortKeys, indexName, queryField
  - Read `model.data.identifier` for primary key
  - Return `{ primaryKey: [...], secondaryIndexes: [...] }`
- `src/parser/enums.js` — `extractEnums(schema)`:
  - Collect enums from `schema.data.types` if present
  - Also collect inline enums found during field extraction (from Task 2)
  - Deduplicate
  - Return `{ [enumName]: [values] }`
- Update `src/parser/index.js` to:
  - Call all extractors
  - Also extract `authorizationModes` from `data.props.authorizationModes`
  - Attempt to import `amplify/auth/resource.ts` and `amplify/storage/resource.ts` (graceful failure if they don't exist)
  - Return complete parsed schema:
    ```javascript
    {
      models: { [name]: { fields, relationships, enums, authorization, primaryKey, secondaryIndexes } },
      enums: { [name]: [values] },
      authorizationModes: { defaultAuthorizationMode, ... },
      authConfig: { groups, passwordPolicy } | null,
      storageConfig: { paths, bucketName } | null,
    }
    ```
- Update test fixture to include auth rules, indexes, and enums on the test models

**Acceptance Criteria**:
- [ ] Auth rules correctly extracted from Symbol(data) — all strategies (public/apiKey, public/iam, private, groups, owner)
- [ ] Operations arrays correct per rule (e.g., public gets ['read'], admins get all four)
- [ ] Group names extracted (e.g., 'admins', 'regionAdmins')
- [ ] Secondary indexes extracted with partitionKey and sortKeys
- [ ] Primary key extracted (default 'id' and custom)
- [ ] Composite index keys work (partition + sort)
- [ ] Enums extracted with all values
- [ ] Authorization modes extracted (default mode, API key config)
- [ ] Missing auth/storage resource files handled gracefully (null, no crash)
- [ ] Complete parsed schema object returned from parser/index.js

**Creates**: Full parsed schema with everything needed to generate outputs, create tables, build GraphQL schema, and enforce auth. Next task uses this to generate amplify_outputs.json.

---

## Task 4: Output generator — amplify_outputs.json from parsed schema

**Context**: Parser from Tasks 2-3 produces a complete parsed schema. This task builds the generator that converts it into a valid `amplify_outputs.json` file. The key challenge is building the `model_introspection` section in the exact format the Amplify client SDK expects.

Reference: The first document in this conversation is a real `amplify_outputs.json` — use it as the target format for the `model_introspection` structure. The generator must produce output in that same shape.

**Build**:
- `src/generator/introspection.js` — `buildIntrospection(parsedSchema)`:
  - Convert each parsed model to the introspection format (matching the structure in a real amplify_outputs.json):
    - `name`, `pluralName` (add 's', handle 'y' → 'ies', etc.), `fields` object
    - Each field: `name`, `isArray`, `type` (scalar name or `{model: name}` for relations), `isRequired`, `attributes`, `isReadOnly` for timestamps
    - `association` on relationship fields: `connectionType` ('BELONGS_TO' or 'HAS_MANY'), `targetNames` or `associatedWith`
    - Auto-add `id`, `createdAt`, `updatedAt` fields if not already present
    - `attributes` array with model config, key entries (GSIs), and auth rules
    - `primaryKeyInfo` object
    - `syncable: true`
  - Build `enums` section from parsed enums
  - Build `queries` section if custom queries exist
  - Return complete `model_introspection` object with version: 1
- `src/generator/outputs.js` — `generateOutputs(parsedSchema, config)`:
  - Build complete amplify_outputs.json:
    - `auth`: fake user_pool_id (`local_pool_xxx`), fake client_id, fake identity_pool_id, region `us-east-1`, password policy from parsed auth config or defaults, groups from parsed auth config, mfa_configuration `NONE`, unauthenticated_identities_enabled true
    - `data`: url `http://localhost:{graphqlPort}/graphql`, api_key `local-api-key-000000`, region `us-east-1`, default_authorization_type from parsed authorizationModes, authorization_types array, model_introspection from buildIntrospection()
    - `storage` (if parsedSchema.storageConfig exists): bucket_name `amplify-local-storage`, region, paths from parsed config
    - `custom` (if config has rest endpoints): rewrite to localhost:{restPort}/{key}/
    - `version: "1.4"`
  - Write JSON to config.output path
- Wire `generate` CLI command: load config → parse schema → generate outputs → print summary including env var instructions

**Acceptance Criteria**:
- [ ] Generated file is valid JSON
- [ ] `model_introspection` models match parsed schema (correct fields, types, associations)
- [ ] Plural names are reasonable (Product→Products, Category→Categories, Property→Properties)
- [ ] GSIs appear in model attributes as key entries
- [ ] Auth rules appear in model attributes
- [ ] Auto-generated fields (id, createdAt, updatedAt) present on all models
- [ ] Relationship fields have correct association info (connectionType, targetNames/associatedWith)
- [ ] Enum types listed in introspection enums section
- [ ] Auth section has fake pool IDs, no real credentials
- [ ] `amplify-local generate` CLI command works end-to-end
- [ ] Missing storage/custom config handled gracefully (sections omitted)

**Creates**: Valid amplify_outputs.json from TypeScript definitions. Next task builds the auth token system.

---

## Task 5: Static token auth system

**Context**: Generator from Task 4 produces outputs with fake pool IDs. This task builds the JWT infrastructure that generates static tokens for test users and provides middleware for the GraphQL/Storage servers to validate them.

**Build**:
- `src/auth/jwt.js`:
  - `initKeys(dataDir)` — generate RSA-2048 key pair using `jose`, persist to `.amplify-local/keys/private.pem` and `public.pem`. Load existing keys on subsequent runs.
  - `signIdToken({ sub, email, groups, poolId, clientId })` — RS256 JWT with claims: `iss` (pool ID URL), `aud` (client ID), `token_use: 'id'`, `sub`, `email`, `cognito:username` (= sub), `cognito:groups`, `auth_time`, `iat`, `exp` (24hr for local dev convenience)
  - `signAccessToken({ sub, clientId })` — RS256 JWT with `token_use: 'access'`, `client_id`, `scope: 'aws.cognito.signin.user.admin'`
  - `getJwks()` — JWKS JSON with public key
  - `verifyToken(token)` — verify signature + expiry, return decoded payload
- `src/auth/token-manager.js`:
  - `generateTokens(users, authConfig)` — for each user in config, generate idToken and accessToken. Write to `.amplify-local/tokens.json`. Also generate an API key string. Return the tokens map.
- `src/auth/middleware.js`:
  - Express middleware `createAuthMiddleware(jwks)`:
    - Check `x-api-key` header → set `req.authContext = { type: 'apiKey' }`
    - Check `Authorization: Bearer {token}` → decode JWT, set `req.authContext = { type: 'userPool', sub, email, groups }`
    - No auth header → set `req.authContext = { type: 'iam', authenticated: false }`
    - Never reject requests — just attach context. Auth enforcement happens per-operation in the GraphQL layer.
- `src/auth/enforcer.js`:
  - `createAuthEnforcer(parsedModels)` — returns `authorize(modelName, operation, authContext, item?)`:
    - Look up auth rules for the model
    - Evaluate rules in order:
      - `strategy: 'public'` + `provider: 'apiKey'` → allow if authContext.type === 'apiKey' and operation is in rule's operations
      - `strategy: 'public'` + `provider: 'identityPool'` → allow if operation is in rule's operations (IAM = permissive locally)
      - `strategy: 'private'` → allow if authContext.type === 'userPool' and operation is in rule's operations
      - `strategy: 'groups'` → allow if authContext.groups includes any of rule's groups and operation is in rule's operations
      - `strategy: 'owner'` → allow if authContext.sub matches item's owner field, or for create operations allow and set owner
    - Return `{ allowed: boolean, reason: string }` for first matching rule
    - If no rule matches: `{ allowed: false, reason: 'No matching auth rule' }`
    - For list operations with owner rules: return `{ allowed: true, ownerFilter: { field: 'owner', value: authContext.sub } }` so the resolver can inject a filter

**Acceptance Criteria**:
- [ ] RSA keys generated on first run, loaded from disk on subsequent runs
- [ ] Generated JWTs decode correctly with `jose` and contain all expected claims
- [ ] `cognito:groups` claim is an array of group names
- [ ] tokens.json written with valid tokens for all configured users
- [ ] Middleware correctly identifies apiKey, Bearer token, and no-auth requests
- [ ] Enforcer allows public apiKey read on a model with that rule
- [ ] Enforcer allows admin group full CRUD
- [ ] Enforcer denies customer group write on admin-only model
- [ ] Enforcer handles owner-based rules (allow own, deny others)
- [ ] Enforcer returns ownerFilter for list operations on owner-based models
- [ ] JWKS endpoint data is valid

**Creates**: Complete auth layer. Next task builds DynamoDB table management.

---

## Task 6: DynamoDB client + table creator from parsed schema

**Context**: Parser produces models with fields, primaryKey, and secondaryIndexes. This task creates DynamoDB tables matching the schema in DynamoDB Local.

**Build**:
- Add `@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb` as dependencies
- `src/dynamo/client.js`:
  - `createDynamoClient(endpoint)` — DynamoDBClient with dummy credentials, configurable endpoint (default http://localhost:8000)
  - `createDocClient(endpoint)` — DynamoDBDocumentClient wrapping the above
- `src/dynamo/table-creator.js` — `createTables(parsedSchema, dynamoClient, options)`:
  - For each model in parsedSchema.models:
    - Table name = model name (e.g., `Product`, `Order`)
    - Primary key from `model.primaryKey` (usually `[{name: 'id', type: 'S'}]`)
    - Type mapping for key attributes: look up field type → `ID`/`String`/`AWSDateTime`/enums → `S`, `Int`/`Float` → `N`
    - Build GSIs from `model.secondaryIndexes`: each has partitionKey (HASH) and optional sortKeys[0] (RANGE), index name derived from partition+sort key names if indexName is empty
    - CreateTable with BillingMode PAY_PER_REQUEST
    - All GSIs project ALL attributes
  - Idempotent: catch `ResourceInUseException`, log skip
  - `options.reset`: delete table first (DeleteTable, wait, then create)
  - Return summary: `{ created: [...], skipped: [...], failed: [...] }`
- Wire `setup-tables` CLI command: load config → parse schema → create tables → print summary
- Wire `setup-tables --reset`: add reset flag
- `docker/docker-compose.yml`:
  ```yaml
  services:
    dynamodb-local:
      image: amazon/dynamodb-local:latest
      command: "-jar DynamoDBLocal.jar -sharedDb -dbPath /data"
      ports: ['8000:8000']
      volumes: [dynamodb-data:/data]
      healthcheck:
        test: ["CMD-SHELL", "curl -sf http://localhost:8000/shell/ || exit 1"]
        interval: 5s
        retries: 3
  volumes:
    dynamodb-data:
  ```

**Acceptance Criteria**:
- [ ] Client connects to DynamoDB Local and can listTables
- [ ] Creates tables with correct primary keys (hash key = id, type S)
- [ ] GSIs created with correct partition and sort keys
- [ ] Composite GSI keys work (partition + sort, e.g., partnerId + visitedAt)
- [ ] Type mapping correct (ID→S, String→S, Int→N, Float→N, AWSDateTime→S)
- [ ] Running twice skips existing tables (idempotent)
- [ ] `--reset` drops and recreates tables
- [ ] `amplify-local setup-tables` CLI command works
- [ ] docker-compose.yml starts DynamoDB Local
- [ ] Helpful error message if DynamoDB Local not running

**Creates**: DynamoDB tables from parsed schema. Next task builds the GraphQL schema generator.

---

## Task 7: GraphQL schema generator + CRUD resolvers

**Context**: Parsed schema has models/fields/relationships/enums/indexes. DynamoDB tables exist. This task generates a GraphQL schema and CRUD resolvers. This is the largest task — the resolver factory is the most complex piece of the package.

**Build**:
- Add `graphql` and `@graphql-tools/schema` as dependencies
- `src/services/graphql/schema-generator.js` — `generateSchema(parsedSchema)`:
  - Generate SDL string:
    - Enum types from parsedSchema.enums
    - Object type per model: scalar fields mapped (ID→ID, String→String, Int→Int, Float→Float, Boolean→Boolean, AWSDateTime→String, AWSJSON→String, enum→enum name), relationship fields as `RelatedModel` or `[RelatedModel]`
    - `ModelConnection` type per model: `{ items: [Model], nextToken: String }`
    - Input types: `CreateModelInput` (required fields required, optional fields optional, omit id/createdAt/updatedAt/relationships), `UpdateModelInput` (id required, everything else optional), `DeleteModelInput` (just id)
    - `ModelFilterInput` with fields for each scalar: `{ eq, ne, gt, lt, ge, le, contains, beginsWith, between }` typed appropriately
    - Query type: `getModel(id: ID!): Model`, `listModels(filter: ModelFilterInput, limit: Int, nextToken: String): ModelConnection`, GSI queries from secondaryIndexes
    - Mutation type: `createModel(input: CreateModelInput!): Model`, `updateModel(input: UpdateModelInput!): Model`, `deleteModel(input: DeleteModelInput!): Model`
  - Use `makeExecutableSchema` to build executable schema (resolvers attached later)
- `src/services/graphql/filters.js` — `buildFilterExpression(filter)`:
  - Convert GraphQL filter object to DynamoDB FilterExpression + ExpressionAttributeNames + ExpressionAttributeValues
  - Support: eq, ne, gt, lt, ge, le, contains, notContains, beginsWith, between
  - Support `and`, `or`, `not` combinators (nested)
  - Return `{ FilterExpression, ExpressionAttributeNames, ExpressionAttributeValues }` or null if no filter
- `src/services/graphql/resolver-factory.js` — `buildResolvers(parsedSchema, docClient)`:
  - For each model:
    - `Query.getModel(_, { id })` → GetCommand on table, return item
    - `Query.listModels(_, { filter, limit, nextToken })` → ScanCommand with filter expression, Limit, ExclusiveStartKey (base64-decoded nextToken). Return `{ items, nextToken: base64(LastEvaluatedKey) }`
    - GSI queries: `Query.listModelByKey(_, { keyValue, sortKeyFilter, filter, limit, nextToken })` → QueryCommand on index with KeyConditionExpression
    - `Mutation.createModel(_, { input })` → generate uuid for id, set createdAt/updatedAt to ISO now, PutCommand, return item
    - `Mutation.updateModel(_, { input })` → UpdateCommand building SET expression from provided fields, auto-set updatedAt, return updated item
    - `Mutation.deleteModel(_, { input })` → DeleteCommand with ReturnValues: 'ALL_OLD', return deleted item
    - Nested resolvers for relationships:
      - `belongsTo` field: resolver does GetCommand using the foreign key value
      - `hasMany` field: resolver does QueryCommand on the related table's GSI (find the GSI where partitionKey matches the relationship's associatedWith field)
  - Return complete resolver map

**Acceptance Criteria**:
- [ ] Generated SDL is valid GraphQL (passes makeExecutableSchema)
- [ ] All model types generated with correct field types
- [ ] Enum types generated
- [ ] Connection types have items + nextToken
- [ ] Input types have correct required/optional fields
- [ ] Filter input types generated per model
- [ ] get query returns item by ID
- [ ] list query returns items with pagination (nextToken)
- [ ] list with filter works (e.g., active: { eq: true })
- [ ] GSI queries work (e.g., listProductByStoreId)
- [ ] create mutation generates id + timestamps, writes to DynamoDB
- [ ] update mutation merges fields, updates updatedAt
- [ ] delete mutation removes item and returns it
- [ ] belongsTo resolves (Product.category returns the Category)
- [ ] hasMany resolves (Category.products returns Products array)

**Creates**: Working GraphQL schema + resolvers. Next task wires them into an Express server with auth.

---

## Task 8: GraphQL server with auth enforcement + custom query stubs

**Context**: Schema generator and resolvers from Task 7, auth middleware/enforcer from Task 5. This task wires them into an Express server and adds auth enforcement to every operation, plus stub resolvers for custom queries.

**Build**:
- `src/services/graphql/auth-enforcer.js`:
  - Wrap the resolver factory output: for each resolver, insert auth check before execution
  - For queries (get/list): check read permission before executing resolver
  - For mutations (create/update/delete): check corresponding permission
  - For list queries on owner-based models: inject owner filter from enforcer result
  - On auth failure: return GraphQL error `{ message: 'Unauthorized', errorType: 'Unauthorized' }` matching AppSync format
- `src/services/graphql/custom-queries.js`:
  - Detect custom queries if they exist in the parsed schema (queries that aren't auto-generated get/list/GSI)
  - Generate simple stub resolvers that return empty results in the expected shape
  - Config override: if `config.customResolvers[queryName]` exists, use that function instead
- `src/services/graphql/server.js`:
  - Express app:
    - POST `/graphql`: parse body, extract auth context via middleware, execute GraphQL with context
    - GET `/graphql`: serve GraphQL Playground HTML (can use a simple static HTML page that loads the playground from CDN)
    - CORS headers (allow all origins for local dev)
  - AppSync-compatible response format: `{ data, errors }` where errors have `{ message, errorType, locations }`
  - Export `createGraphQLServer(config, parsedSchema, docClient, authEnforcer)` factory that returns the Express app (does not call listen)

**Acceptance Criteria**:
- [ ] POST /graphql executes queries and returns data
- [ ] GET /graphql serves a playground UI
- [ ] API key auth: can read public models, cannot write
- [ ] Bearer token auth: admin group can CRUD, customer group restricted per model rules
- [ ] No auth: unauthenticated can read IAM-public models
- [ ] Owner-based model: user can only read/modify their own items
- [ ] Auth errors return `{ errorType: 'Unauthorized' }` format
- [ ] Custom query stubs return empty results (not errors)
- [ ] Custom resolver overrides from config are invoked
- [ ] CORS headers present on responses

**Creates**: Fully functional GraphQL server with auth. Next task builds storage + REST + seed.

---

## Task 9: Storage server + REST mock + seed utility

**Context**: GraphQL server works. This task adds the remaining services: filesystem-based S3 storage, static REST mocks, and the data seeder. These are all simpler than GraphQL so they're combined into one task.

**Build**:
- `src/services/storage/server.js`:
  - Express app on configurable port implementing S3-compatible routes:
    - `PUT /:bucket/*` → mkdir -p + write file to `.amplify-local/storage/{key}`, set Content-Type from request header
    - `GET /:bucket/*` → read file, return with stored Content-Type (or guess from extension)
    - `DELETE /:bucket/*` → delete file
    - `HEAD /:bucket/*` → check existence, return Content-Length
    - `GET /:bucket?prefix=&max-keys=` → list files matching prefix, return XML matching S3 ListObjectsV2 response format
  - Export `createStorageServer(config)` factory
- `src/services/storage/policy.js`:
  - `checkStorageAccess(path, operation, authContext, storageConfig)`:
    - Match request path against configured storage paths (e.g., `products/*`, `public/*`)
    - Check if auth level (guest, authenticated, group) has permission for the operation (get, list, write, delete)
    - Return allowed/denied
  - Apply policy as middleware on the storage server
- `src/services/rest/server.js`:
  - Express app that reads `config.rest` object
  - For each endpoint key, mount routes at `/{endpointKey}/`
  - Match incoming method+path against configured responses
  - Default response for unconfigured routes: `{ message: 'mock', endpoint, method, path }`
  - Support `:param` extraction in paths
  - Export `createRestServer(config)` factory
- `src/dynamo/seeder.js`:
  - `seed(filePath, parsedSchema, docClient)`:
    - Read JSON file (keyed by model name, values are arrays of items)
    - For each model's items: auto-generate `id` (uuid) if missing, auto-generate `createdAt`/`updatedAt` if missing
    - Validate model names against parsed schema (warn on unknown)
    - Batch-write using BatchWriteCommand (25 items per batch)
    - Return summary: `{ seeded: { Model: count, ... }, warnings: [...] }`
  - `reset(parsedSchema, dynamoClient)`: delete + recreate all tables (reuse table-creator with reset flag)
  - Wire `seed --file <path>` and `seed --reset` CLI commands

**Acceptance Criteria**:
- [ ] Can PUT a file to storage and GET it back
- [ ] Can DELETE a file
- [ ] HEAD returns 200 for existing, 404 for missing
- [ ] LIST with prefix returns XML with matching keys
- [ ] Storage access rules enforced (guest can read public/, admin can write products/)
- [ ] REST mock returns configured responses for defined routes
- [ ] REST mock returns default response for unconfigured routes
- [ ] Seeder loads JSON, creates items in DynamoDB with auto-generated fields
- [ ] Seeder warns on unknown model names
- [ ] `amplify-local seed --file ./data.json` works
- [ ] `amplify-local seed --reset` clears and re-seeds

**Creates**: All individual services. Next task wires them together.

---

## Task 10: Service orchestrator + start/stop commands

**Context**: All services exist as Express app factories. This task wires them into a single-process orchestrator with health checks, the `start`/`stop`/`status` commands, and the Docker helper.

**Build**:
- `src/services/manager.js`:
  - `start(config)`:
    1. Check DynamoDB Local reachable (HTTP request to endpoint, retry 3x with 2s backoff)
       - On failure: print "DynamoDB Local not found" + docker run command + docker compose suggestion
    2. Parse schema (via parser/index.js)
    3. Create tables (via table-creator, idempotent)
    4. Init auth keys + generate tokens for configured users
    5. Create GraphQL server (with docClient, auth enforcer, parsed schema)
    6. Create Storage server (if not --no-storage)
    7. Create REST server (if not --no-rest)
    8. Start all servers (call .listen() on each)
    9. Run seed if config.seed is set
    10. Generate amplify_outputs.json
    11. Write PID to `.amplify-local/pid`
    12. Print summary:
        ```
        amplify-local is running:
          GraphQL:  http://localhost:4502/graphql
          Storage:  http://localhost:4503
          REST:     http://localhost:4504

          Outputs:  ./amplify_outputs.json
          Tokens:   .amplify-local/tokens.json

          Test users:
            admin@test.com    → groups: [admins]
            customer@test.com → groups: [customers]

          Set in your app:
            NEXT_PUBLIC_USE_LOCAL_BACKEND=true
        ```
  - `stop()`: read PID file, send SIGTERM (or if same process, close all servers)
  - `status()`: check each port is responding, report up/down
- `src/utils/ports.js`:
  - `checkPort(port)` — detect if port is already in use, suggest alternative
- Wire CLI commands:
  - `start`: calls manager.start(), keeps process running
  - `stop`: calls manager.stop()
  - `status`: calls manager.status()
  - `docker:start`: find docker-compose.yml in package, run `docker compose up -d`
  - `docker:stop`: run `docker compose down`

**Acceptance Criteria**:
- [ ] `amplify-local start` brings up all services in correct order
- [ ] Startup prints summary with URLs and user list
- [ ] tokens.json and amplify_outputs.json generated before services start responding
- [ ] Missing DynamoDB Local prints helpful error with Docker command
- [ ] Port conflict detected and reported before binding
- [ ] `amplify-local stop` shuts down cleanly
- [ ] `amplify-local status` reports service health
- [ ] `amplify-local docker:start` starts DynamoDB Local container
- [ ] Process stays running after start (doesn't exit)
- [ ] Ctrl+C gracefully shuts down all servers

**Creates**: Fully functional `amplify-local start` experience. Next task adds tests and docs.

---

## Task 11: Tests, CI, and README

**Context**: Full package is functional. This task adds test coverage, CI pipeline, and documentation for publishing.

**Build**:
- Add `vitest` as dev dependency
- `test/fixtures/minimal-amplify/` — minimal but complete Amplify backend definition:
  - `data/resource.ts` with 3 models (e.g., Todo, User, Comment) with relationships, enums, auth rules, GSIs
  - `auth/resource.ts` with groups (admins, users)
  - `storage/resource.ts` with paths (public/*, private/*)
  - Keep it small but representative. Needs `@aws-amplify/backend` as devDep.
- `test/unit/parser.test.js` — test parser against fixture:
  - Models extracted with correct field counts and types
  - Auth rules extracted from Symbols
  - Indexes extracted
  - Relationships extracted
- `test/unit/generator.test.js`:
  - Generated introspection has correct structure
  - Plural names correct
  - Auth section has fake credentials
- `test/unit/auth.test.js`:
  - JWT sign + verify roundtrip
  - Token manager generates tokens for all users
  - Enforcer: public read allowed, admin CRUD allowed, unauthorized denied, owner filter returned
- `test/unit/filters.test.js`:
  - Filter builder produces correct DynamoDB expressions
- `test/integration/lifecycle.test.js` (requires DynamoDB Local):
  - Parse → create tables → seed → query via GraphQL → verify auth enforcement
  - Mark as integration test (skip if DynamoDB not available)
- `.github/workflows/test.yml`:
  - Run unit tests on push
  - Run integration tests with DynamoDB Local as a service container
- `README.md`:
  - What it is (paragraph)
  - Quickstart: install → configure users → start DynamoDB → amplify-local start → use in tests
  - CLI reference (all commands)
  - Config file reference
  - Seed data format
  - Test usage pattern (with code example showing how to grab tokens and make GraphQL requests)
  - CI setup (GitHub Actions example with DynamoDB sidecar)
  - Architecture overview
  - Auth tiers explanation
  - Limitations
- `CHANGELOG.md` (v0.1.0)
- Verify `npm pack` produces clean package

**Acceptance Criteria**:
- [ ] `npm test` passes all unit tests
- [ ] Parser tests verify model/field/auth/index extraction
- [ ] Auth tests verify JWT + enforcer logic
- [ ] Filter tests verify DynamoDB expression building
- [ ] Integration test runs full lifecycle (with DynamoDB Local)
- [ ] GitHub Actions workflow defined and would pass
- [ ] README has complete quickstart that a new user can follow
- [ ] `npm pack` produces installable package
- [ ] No test depends on the Stocked schema (all use minimal fixture)

**Creates**: Tested, documented, publishable v0.1.0.

---

## Summary

| Task | Focus | Key Outputs | Estimated Size |
|------|-------|-------------|----------------|
| 1 | Scaffold | CLI + config loader | Small-medium |
| 2 | Parser pt1 | TS import + models/fields/relationships | Medium |
| 3 | Parser pt2 | Auth rules + indexes + enums + config | Medium |
| 4 | Generator | amplify_outputs.json from parsed schema | Medium-large |
| 5 | Auth | JWT + tokens + middleware + enforcer | Medium |
| 6 | DynamoDB | Client + table creator + Docker compose | Medium |
| 7 | GraphQL pt1 | Schema gen + CRUD resolvers + filters | Large |
| 8 | GraphQL pt2 | Server + auth enforcement + custom queries | Medium |
| 9 | Services | Storage + REST mock + seeder | Medium |
| 10 | Orchestration | start/stop/status + service manager | Medium |
| 11 | Ship | Tests + CI + README | Medium-large |
