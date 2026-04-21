import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { parseSchema } from '../../src/parser/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, '..', 'fixtures', 'minimal-amplify');

describe('parseSchema (minimal-amplify fixture)', () => {
  let parsed;

  beforeAll(async () => {
    parsed = await parseSchema(FIXTURE);
  });

  it('returns the expected top-level shape', () => {
    expect(parsed).toHaveProperty('models');
    expect(parsed).toHaveProperty('enums');
    expect(parsed).toHaveProperty('authorizationModes');
    expect(parsed.authorizationModes.defaultAuthorizationMode).toBe('apiKey');
  });

  it('extracts all three models', () => {
    expect(Object.keys(parsed.models).sort()).toEqual(['Category', 'Product', 'Review']);
  });

  describe('Category', () => {
    it('has scalar fields name (required) and description (optional)', () => {
      const fields = parsed.models.Category.fields;
      expect(fields.name).toMatchObject({ type: 'String', required: true });
      expect(fields.description).toMatchObject({ type: 'String', required: false });
    });

    it('has a hasMany relationship to Product', () => {
      const rel = parsed.models.Category.relationships.products;
      expect(rel).toMatchObject({ type: 'hasMany', model: 'Product' });
      expect(rel.references).toContain('categoryId');
    });

    it('has auth rules for publicApiKey read and admins group', () => {
      const rules = parsed.models.Category.authorization;
      expect(rules).toHaveLength(2);
      const publicRule = rules.find((r) => r.strategy === 'public');
      expect(publicRule.provider).toBe('apiKey');
      expect(publicRule.operations).toEqual(['read']);
      const groupRule = rules.find((r) => r.strategy === 'groups');
      expect(groupRule.groups).toEqual(['admins']);
      expect(groupRule.operations.sort()).toEqual(['create', 'delete', 'read', 'update']);
    });
  });

  describe('Product', () => {
    it('extracts array and json field types', () => {
      const fields = parsed.models.Product.fields;
      expect(fields.tags).toMatchObject({ type: 'String', array: true });
      expect(fields.metadata).toMatchObject({ type: 'AWSJSON' });
    });

    it('extracts belongsTo and hasMany relationships', () => {
      const rels = parsed.models.Product.relationships;
      expect(rels.category).toMatchObject({ type: 'belongsTo', model: 'Category' });
      expect(rels.reviews).toMatchObject({ type: 'hasMany', model: 'Review' });
    });

    it('picks up secondary indexes', () => {
      const indexes = parsed.models.Product.secondaryIndexes;
      expect(indexes).toHaveLength(2);
      const byCategory = indexes.find((i) => i.partitionKey === 'categoryId');
      const bySku = indexes.find((i) => i.partitionKey === 'sku');
      expect(byCategory).toBeDefined();
      expect(bySku).toBeDefined();
      expect(bySku.indexName).toBe('bySkuIndex');
    });

    it('captures the inline StatusEnum on the status field', () => {
      expect(parsed.models.Product.enums.status).toEqual(['ACTIVE', 'INACTIVE', 'PENDING']);
    });
  });

  describe('Review', () => {
    it('has public/owner/groups rules together', () => {
      const rules = parsed.models.Review.authorization;
      const strategies = rules.map((r) => r.strategy).sort();
      expect(strategies).toEqual(['groups', 'owner', 'public']);
    });
  });

  describe('top-level enums', () => {
    it('includes the inline StatusEnum once, deduplicated', () => {
      const enumNames = Object.keys(parsed.enums);
      expect(enumNames.length).toBeGreaterThan(0);
      const values = Object.values(parsed.enums).find(
        (v) => Array.isArray(v) && v.length === 3 && v.includes('ACTIVE')
      );
      expect(values).toEqual(['ACTIVE', 'INACTIVE', 'PENDING']);
    });
  });

  it('handles a missing amplify directory by throwing', async () => {
    await expect(parseSchema('/does/not/exist')).rejects.toThrow();
  });
});
