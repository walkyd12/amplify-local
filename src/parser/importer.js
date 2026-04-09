import { resolve } from 'path';
import { existsSync } from 'fs';
import { pathToFileURL } from 'url';
import { tsImport } from 'tsx/esm/api';

/**
 * Import an Amplify Gen 2 TypeScript resource file at runtime using tsx.
 * Returns the default or named export.
 */
async function importTsFile(filePath) {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const mod = await tsImport(filePath, import.meta.url);
    return mod;
  } catch (err) {
    throw new Error(
      `Failed to import ${filePath}: ${err.message}\n` +
        `  Make sure all dependencies are installed (npm install).`
    );
  }
}

/**
 * Import the Amplify data resource and return the schema object.
 * Looks for amplify/data/resource.ts in the configured amplify directory.
 */
export async function importSchema(amplifyDir) {
  const resourcePath = resolve(amplifyDir, 'data', 'resource.ts');

  if (!existsSync(resourcePath)) {
    throw new Error(
      `Data resource not found: ${resourcePath}\n` +
        `  Expected amplify/data/resource.ts with a defineData() export.`
    );
  }

  const mod = await importTsFile(resourcePath);
  const data = mod.data || mod.default;

  if (!data) {
    throw new Error(
      `No 'data' export found in ${resourcePath}\n` +
        `  Expected: export const data = defineData({ schema });`
    );
  }

  // Navigate to the schema object
  const schema = data?.props?.schema;
  if (!schema) {
    throw new Error(
      `Could not find schema at data.props.schema in ${resourcePath}\n` +
        `  Make sure the file uses defineData() from @aws-amplify/backend.`
    );
  }

  return { data, schema };
}

/**
 * Import the Amplify auth resource if it exists.
 */
export async function importAuthConfig(amplifyDir) {
  const resourcePath = resolve(amplifyDir, 'auth', 'resource.ts');
  const mod = await importTsFile(resourcePath);
  if (!mod) return null;
  return mod.auth || mod.default || null;
}

/**
 * Import the Amplify storage resource if it exists.
 */
export async function importStorageConfig(amplifyDir) {
  const resourcePath = resolve(amplifyDir, 'storage', 'resource.ts');
  const mod = await importTsFile(resourcePath);
  if (!mod) return null;
  return mod.storage || mod.default || null;
}
