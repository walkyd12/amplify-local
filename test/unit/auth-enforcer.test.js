import { describe, it, expect } from 'vitest';
import { createAuthEnforcer } from '../../src/auth/enforcer.js';

function model(rules) {
  return { Post: { authorization: rules } };
}

const apiKeyCtx = { type: 'apiKey', valid: true };
const anonCtx = { type: 'anonymous' };
const userCtx = (overrides = {}) => ({
  type: 'userPool',
  sub: 'user-123',
  email: 'u@test.local',
  groups: [],
  ...overrides,
});

describe('createAuthEnforcer', () => {
  it('returns unknown-model error for missing model', () => {
    const { authorize } = createAuthEnforcer({});
    const r = authorize('Ghost', 'read', apiKeyCtx);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/unknown model/i);
  });

  it('allows any operation when no rules are defined', () => {
    const { authorize } = createAuthEnforcer({ Post: { authorization: [] } });
    expect(authorize('Post', 'create', anonCtx).allowed).toBe(true);
  });

  it('denies operation when no rule matches', () => {
    const rules = [{ strategy: 'public', provider: 'apiKey', operations: ['read'] }];
    const { authorize } = createAuthEnforcer(model(rules));
    expect(authorize('Post', 'create', apiKeyCtx).allowed).toBe(false);
    expect(authorize('Post', 'create', apiKeyCtx).reason).toMatch(/no matching/i);
  });

  describe('public / apiKey', () => {
    const rules = [{ strategy: 'public', provider: 'apiKey', operations: ['read'] }];
    const { authorize } = createAuthEnforcer(model(rules));

    it('allows read with a valid API key', () => {
      expect(authorize('Post', 'read', apiKeyCtx).allowed).toBe(true);
    });

    it('denies read without an API key', () => {
      expect(authorize('Post', 'read', anonCtx).allowed).toBe(false);
    });

    it('denies read when API key is invalid', () => {
      expect(authorize('Post', 'read', { type: 'apiKey', valid: false }).allowed).toBe(false);
    });
  });

  describe('public / identityPool (IAM)', () => {
    const rules = [{ strategy: 'public', provider: 'identityPool', operations: ['read'] }];
    const { authorize } = createAuthEnforcer(model(rules));

    it('is permissive locally', () => {
      expect(authorize('Post', 'read', anonCtx).allowed).toBe(true);
    });
  });

  describe('private', () => {
    const rules = [{ strategy: 'private', operations: ['read', 'create'] }];
    const { authorize } = createAuthEnforcer(model(rules));

    it('allows any authenticated user', () => {
      expect(authorize('Post', 'create', userCtx()).allowed).toBe(true);
    });

    it('denies anonymous', () => {
      expect(authorize('Post', 'create', anonCtx).allowed).toBe(false);
    });

    it('denies a token marked invalid', () => {
      expect(authorize('Post', 'create', userCtx({ invalid: true })).allowed).toBe(false);
    });
  });

  describe('groups', () => {
    const rules = [{ strategy: 'groups', groups: ['admins'], operations: ['create'] }];
    const { authorize } = createAuthEnforcer(model(rules));

    it('allows a user in the group', () => {
      expect(authorize('Post', 'create', userCtx({ groups: ['admins'] })).allowed).toBe(true);
    });

    it('denies a user not in the group', () => {
      expect(authorize('Post', 'create', userCtx({ groups: ['other'] })).allowed).toBe(false);
    });

    it('denies an anonymous caller', () => {
      expect(authorize('Post', 'create', apiKeyCtx).allowed).toBe(false);
    });
  });

  describe('owner', () => {
    const rules = [{ strategy: 'owner', operations: ['read', 'create', 'update'] }];
    const { authorize } = createAuthEnforcer(model(rules));

    it('allows create without an item (any authed user)', () => {
      const r = authorize('Post', 'create', userCtx());
      expect(r.allowed).toBe(true);
      expect(r.ownerField).toBe('owner');
      expect(r.ownerValue).toBe('user-123');
    });

    it('returns an ownerFilter for list-like operations without an item', () => {
      const r = authorize('Post', 'read', userCtx());
      expect(r.ownerFilter).toEqual({ field: 'owner', value: 'user-123' });
    });

    it('allows when the item is owned by the caller', () => {
      const r = authorize('Post', 'update', userCtx(), { owner: 'user-123' });
      expect(r.allowed).toBe(true);
    });

    it('denies when the item belongs to someone else', () => {
      const r = authorize('Post', 'update', userCtx(), { owner: 'someone-else' });
      expect(r.allowed).toBe(false);
    });

    it('honors custom ownerField', () => {
      const customRules = [
        { strategy: 'owner', groupOrOwnerField: 'authorId', operations: ['update'] },
      ];
      const { authorize: auth2 } = createAuthEnforcer(model(customRules));
      const r = auth2('Post', 'update', userCtx(), { authorId: 'user-123' });
      expect(r.allowed).toBe(true);
    });

    it('denies anonymous', () => {
      expect(authorize('Post', 'create', apiKeyCtx).allowed).toBe(false);
    });
  });

  it('first matching rule wins — later rules ignored', () => {
    const rules = [
      { strategy: 'public', provider: 'apiKey', operations: ['read'] },
      { strategy: 'groups', groups: ['admins'], operations: ['read'] },
    ];
    const { authorize } = createAuthEnforcer(model(rules));
    const r = authorize('Post', 'read', apiKeyCtx);
    expect(r.allowed).toBe(true);
    expect(r.reason).toMatch(/api key/i);
  });
});
