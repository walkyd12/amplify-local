import { describe, it, expect } from 'vitest';
import { buildFilterExpression } from '../../src/services/graphql/filters.js';

describe('buildFilterExpression', () => {
  it('returns null for empty or missing filter', () => {
    expect(buildFilterExpression(null)).toBeNull();
    expect(buildFilterExpression(undefined)).toBeNull();
    expect(buildFilterExpression({})).toBeNull();
  });

  it('builds an eq comparison', () => {
    const r = buildFilterExpression({ name: { eq: 'Widget' } });
    expect(r.FilterExpression).toBe('#f0 = :v0');
    expect(r.ExpressionAttributeNames).toEqual({ '#f0': 'name' });
    expect(r.ExpressionAttributeValues).toEqual({ ':v0': 'Widget' });
  });

  it('supports all scalar comparison operators', () => {
    const ops = [
      ['ne', '<>'],
      ['gt', '>'],
      ['lt', '<'],
      ['ge', '>='],
      ['le', '<='],
    ];
    for (const [gqlOp, dynamoOp] of ops) {
      const r = buildFilterExpression({ price: { [gqlOp]: 10 } });
      expect(r.FilterExpression).toContain(dynamoOp);
      expect(r.ExpressionAttributeValues[':v0']).toBe(10);
    }
  });

  it('builds function-style expressions', () => {
    expect(buildFilterExpression({ name: { contains: 'x' } }).FilterExpression)
      .toBe('contains(#f0, :v0)');
    expect(buildFilterExpression({ name: { notContains: 'x' } }).FilterExpression)
      .toBe('NOT contains(#f0, :v0)');
    expect(buildFilterExpression({ sku: { beginsWith: 'WDG' } }).FilterExpression)
      .toBe('begins_with(#f0, :v0)');
  });

  it('builds a between expression with two values', () => {
    const r = buildFilterExpression({ price: { between: [5, 20] } });
    expect(r.FilterExpression).toBe('#f0 BETWEEN :v0 AND :v1');
    expect(r.ExpressionAttributeValues).toEqual({ ':v0': 5, ':v1': 20 });
  });

  it('ignores malformed between arrays', () => {
    expect(buildFilterExpression({ price: { between: [5] } })).toBeNull();
    expect(buildFilterExpression({ price: { between: 'bad' } })).toBeNull();
  });

  it('joins multiple field comparisons with AND', () => {
    const r = buildFilterExpression({ price: { gt: 5 }, inStock: { eq: true } });
    expect(r.FilterExpression).toBe('#f0 > :v0 AND #f1 = :v1');
    expect(r.ExpressionAttributeNames).toEqual({ '#f0': 'price', '#f1': 'inStock' });
    expect(r.ExpressionAttributeValues).toEqual({ ':v0': 5, ':v1': true });
  });

  it('combines multiple operators on the same field with AND', () => {
    const r = buildFilterExpression({ price: { gt: 5, lt: 20 } });
    expect(r.FilterExpression).toBe('#f0 > :v0 AND #f0 < :v1');
  });

  it('builds AND combinator', () => {
    const r = buildFilterExpression({
      and: [{ price: { gt: 5 } }, { inStock: { eq: true } }],
    });
    expect(r.FilterExpression).toBe('(#f0 > :v0 AND #f1 = :v1)');
  });

  it('builds OR combinator', () => {
    const r = buildFilterExpression({
      or: [{ status: { eq: 'A' } }, { status: { eq: 'B' } }],
    });
    expect(r.FilterExpression).toBe('(#f0 = :v0 OR #f1 = :v1)');
  });

  it('builds NOT combinator', () => {
    const r = buildFilterExpression({ not: { price: { lt: 5 } } });
    expect(r.FilterExpression).toBe('NOT (#f0 < :v0)');
  });

  it('handles nested combinators', () => {
    const r = buildFilterExpression({
      or: [
        { price: { lt: 5 } },
        { and: [{ price: { gt: 100 } }, { inStock: { eq: true } }] },
      ],
    });
    expect(r.FilterExpression).toMatch(/^\(.+ OR \(.+AND.+\)\)$/);
  });

  it('skips null/undefined operator values', () => {
    const r = buildFilterExpression({ name: { eq: null, ne: undefined, gt: 'x' } });
    expect(r.FilterExpression).toBe('#f0 > :v0');
    expect(r.ExpressionAttributeValues).toEqual({ ':v0': 'x' });
  });

  it('skips unknown operators silently', () => {
    const r = buildFilterExpression({ name: { eq: 'x', bogus: 'y' } });
    expect(r.FilterExpression).toBe('#f0 = :v0');
  });
});
