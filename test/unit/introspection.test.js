import { describe, it, expect, beforeAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseSchema } from '../../src/parser/index.js';
import { buildIntrospection } from '../../src/generator/introspection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, '..', 'fixtures', 'minimal-amplify');

describe('buildIntrospection', () => {
  let introspection;

  beforeAll(async () => {
    const parsed = await parseSchema(FIXTURE);
    introspection = buildIntrospection(parsed);
  });

  it('has version 1 and models/enums/nonModels top-level keys', () => {
    expect(introspection.version).toBe(1);
    expect(introspection).toHaveProperty('models');
    expect(introspection).toHaveProperty('enums');
    expect(introspection).toHaveProperty('nonModels');
  });

  it('includes all three models with plural names', () => {
    expect(introspection.models.Category.pluralName).toBe('Categories');
    expect(introspection.models.Product.pluralName).toBe('Products');
    expect(introspection.models.Review.pluralName).toBe('Reviews');
  });

  it('marks createdAt/updatedAt as read-only AWSDateTime', () => {
    const ts = introspection.models.Category.fields.createdAt;
    expect(ts.type).toBe('AWSDateTime');
    expect(ts.isReadOnly).toBe(true);
  });

  it('renders belongsTo association as BELONGS_TO with targetNames', () => {
    const cat = introspection.models.Product.fields.category;
    expect(cat.type).toEqual({ model: 'Category' });
    expect(cat.isArray).toBe(false);
    expect(cat.association).toEqual({
      connectionType: 'BELONGS_TO',
      targetNames: ['categoryId'],
    });
  });

  it('renders hasMany as isArray=true with HAS_MANY association', () => {
    const products = introspection.models.Category.fields.products;
    expect(products.type).toEqual({ model: 'Product' });
    expect(products.isArray).toBe(true);
    expect(products.association.connectionType).toBe('HAS_MANY');
    expect(products.association.associatedWith).toContain('categoryId');
  });

  it('emits the model key attribute with primary key', () => {
    const attrs = introspection.models.Category.attributes;
    const modelAttr = attrs.find((a) => a.type === 'model');
    const keyAttr = attrs.find((a) => a.type === 'key' && !a.properties.name);
    expect(modelAttr).toBeDefined();
    expect(keyAttr.properties.fields).toEqual(['id']);
  });

  it('emits a key attribute per GSI with name and fields', () => {
    const attrs = introspection.models.Product.attributes;
    const gsiAttrs = attrs.filter((a) => a.type === 'key' && a.properties.name);
    expect(gsiAttrs.length).toBe(2);
    const bySku = gsiAttrs.find((a) => a.properties.name === 'bySkuIndex');
    expect(bySku.properties.fields).toEqual(['sku']);
  });

  it('emits auth attribute with mapped rules', () => {
    const attrs = introspection.models.Category.attributes;
    const auth = attrs.find((a) => a.type === 'auth');
    expect(auth).toBeDefined();
    const rules = auth.properties.rules;
    expect(rules.some((r) => r.allow === 'public' && r.provider === 'apiKey')).toBe(true);
    expect(rules.some((r) => r.allow === 'groups' && r.groups?.includes('admins'))).toBe(true);
  });

  it('sets primaryKeyInfo with default id primary key', () => {
    expect(introspection.models.Category.primaryKeyInfo).toEqual({
      isCustomPrimaryKey: false,
      primaryKeyFieldName: 'id',
      sortKeyFieldNames: [],
    });
  });

  it('includes the StatusEnum', () => {
    const enumEntry = Object.values(introspection.enums).find(
      (e) => Array.isArray(e.values) && e.values.includes('ACTIVE')
    );
    expect(enumEntry).toBeDefined();
    expect(enumEntry.values).toEqual(['ACTIVE', 'INACTIVE', 'PENDING']);
  });

  it('renders enum fields as { enum: Name }', () => {
    const status = introspection.models.Product.fields.status;
    expect(status.type).toHaveProperty('enum');
  });
});
