import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Multiple copies of `graphql` exist under node_modules (root + nested under
  // @aws-amplify packages). Running integration tests with vitest's default
  // "threads" pool leaves duplicate graphql instances — makeExecutableSchema
  // then throws "Cannot use GraphQLSchema from another module or realm". The
  // "forks" pool runs each test file in a child process so the module graph
  // stays consistent with a normal node run.
  test: {
    include: ['test/unit/**/*.test.js', 'test/integration/**/*.test.js'],
    testTimeout: 15000,
    hookTimeout: 30000,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.js'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.js'],
          environment: 'node',
          pool: 'forks',
          forks: { singleFork: true },
          server: {
            // Force vitest to transform these through its ESM pipeline so they
            // share a single `graphql` module with the test files. Without
            // this, @graphql-tools/schema's CJS build gets a distinct graphql
            // instance and makeExecutableSchema's output fails instanceof
            // checks in graphql(), throwing "Cannot use GraphQLSchema from
            // another module or realm".
            deps: {
              inline: [/@graphql-tools/, /^graphql$/, /graphql\//],
            },
          },
        },
      },
    ],
  },
});
