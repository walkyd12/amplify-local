import { describe, it, expect, beforeAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseSchema } from '../../src/parser/index.js';
import { generateSchema, generateSDL } from '../../src/services/graphql/schema-generator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, '..', 'fixtures', 'minimal-amplify');

describe('generateSDL (minimal-amplify fixture)', () => {
  let parsed;
  let sdl;

  beforeAll(async () => {
    parsed = await parseSchema(FIXTURE);
    sdl = generateSDL(parsed);
  });

  it('defines all three object types', () => {
    expect(sdl).toMatch(/\btype Category\s*\{/);
    expect(sdl).toMatch(/\btype Product\s*\{/);
    expect(sdl).toMatch(/\btype Review\s*\{/);
  });

  it('defines a ModelXConnection for each model', () => {
    expect(sdl).toMatch(/type CategoryConnection\s*\{\s*items: \[Category\]!\s*nextToken: String\s*\}/);
    expect(sdl).toMatch(/type ProductConnection\s*\{/);
    expect(sdl).toMatch(/type ReviewConnection\s*\{/);
  });

  it('emits hasMany as a connection (the Phase 1 bug fix)', () => {
    expect(sdl).toMatch(/products: ProductConnection/);
    expect(sdl).toMatch(/reviews: ReviewConnection/);
    expect(sdl).not.toMatch(/products: \[Product\]/);
  });

  it('emits belongsTo as a single object', () => {
    expect(sdl).toMatch(/category: Category(?!Connection)/);
    expect(sdl).toMatch(/product: Product(?!Connection)/);
  });

  it('generates list queries with filter + pagination args', () => {
    expect(sdl).toMatch(
      /listProducts\(filter: ProductFilterInput, limit: Int, nextToken: String\): ProductConnection/
    );
  });

  it('pluralizes model names in list queries', () => {
    expect(sdl).toMatch(/listCategories/);
    expect(sdl).toMatch(/listReviews/);
  });

  it('generates GSI query fields', () => {
    expect(sdl).toMatch(/listProductByCategoryId\(categoryId: ID!/);
    expect(sdl).toMatch(/listProductBySku\(sku: String!/);
  });

  it('generates all CRUD mutations', () => {
    for (const op of ['createCategory', 'updateCategory', 'deleteCategory',
                       'createProduct', 'updateProduct', 'deleteProduct',
                       'createReview', 'updateReview', 'deleteReview']) {
      expect(sdl).toContain(op);
    }
  });

  it('generates the StatusEnum enum type', () => {
    const enumName = Object.keys(parsed.enums)[0];
    expect(sdl).toMatch(new RegExp(`enum ${enumName}\\s*\\{`));
    expect(sdl).toContain('ACTIVE');
    expect(sdl).toContain('INACTIVE');
    expect(sdl).toContain('PENDING');
  });

  it('generates scalar filter input types', () => {
    expect(sdl).toMatch(/input StringFilterInput\s*\{/);
    expect(sdl).toMatch(/input IDFilterInput\s*\{/);
    expect(sdl).toMatch(/input FloatFilterInput\s*\{/);
    expect(sdl).toContain('beginsWith: String');
    expect(sdl).toContain('contains: String');
  });

  it('omits id, createdAt, updatedAt from create input', () => {
    const createInput = sdl.match(/input CreateProductInput\s*\{[^}]+\}/)[0];
    expect(createInput).not.toMatch(/\bid:/);
    expect(createInput).not.toMatch(/createdAt/);
    expect(createInput).not.toMatch(/updatedAt/);
    expect(createInput).toMatch(/name: String!/);
  });

  it('requires id and makes everything else optional in update input', () => {
    const updateInput = sdl.match(/input UpdateProductInput\s*\{[^}]+\}/)[0];
    expect(updateInput).toMatch(/id: ID!/);
    expect(updateInput).toMatch(/name: String(?!!)/);
  });
});

describe('generateSchema', () => {
  it('returns an executable schema for the fixture', async () => {
    const parsed = await parseSchema(FIXTURE);
    const { schema, sdl } = generateSchema(parsed);
    expect(schema).toBeDefined();
    expect(schema.getQueryType().name).toBe('Query');
    expect(schema.getMutationType().name).toBe('Mutation');
    expect(sdl).toBeTruthy();
  });
});
