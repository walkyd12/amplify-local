import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createStorageServer } from '../../src/services/storage/server.js';

const API_KEY = 'test-key-xyz';
let storageDir;
let app;

beforeAll(() => {
  storageDir = mkdtempSync(join(tmpdir(), 'amplify-local-storage-'));
  app = createStorageServer({ storageDir, storageConfig: null }, API_KEY);
});

afterAll(() => {
  rmSync(storageDir, { recursive: true, force: true });
});

describe('storage server — object lifecycle', () => {
  it('PUT then GET round-trips body and Content-Type', async () => {
    await request(app)
      .put('/public/hello.txt')
      .set('x-api-key', API_KEY)
      .set('Content-Type', 'text/plain')
      .send('hi there')
      .expect(200);

    const res = await request(app)
      .get('/public/hello.txt')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.headers.etag).toMatch(/^".+"$/);
    expect(res.text).toBe('hi there');
  });

  it('HEAD returns headers and no body', async () => {
    await request(app)
      .put('/public/head.txt')
      .set('x-api-key', API_KEY)
      .set('Content-Type', 'text/plain')
      .send('abc')
      .expect(200);

    const res = await request(app)
      .head('/public/head.txt')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(res.headers['content-length']).toBe('3');
    expect(res.headers.etag).toBeDefined();
    expect(res.text).toBeUndefined();
  });

  it('GET on missing key returns 404 XML', async () => {
    const res = await request(app)
      .get('/public/nope.txt')
      .set('x-api-key', API_KEY)
      .expect(404);
    expect(res.text).toContain('<Code>NoSuchKey</Code>');
  });

  it('DELETE removes the object; GET afterwards is 404', async () => {
    await request(app)
      .put('/public/doomed.txt')
      .set('x-api-key', API_KEY)
      .send('bye')
      .expect(200);

    await request(app)
      .delete('/public/doomed.txt')
      .set('x-api-key', API_KEY)
      .expect(204);

    await request(app)
      .get('/public/doomed.txt')
      .set('x-api-key', API_KEY)
      .expect(404);
  });

  it('DELETE on missing key still returns 204', async () => {
    await request(app)
      .delete('/public/never-existed.txt')
      .set('x-api-key', API_KEY)
      .expect(204);
  });

  it('handles nested paths', async () => {
    await request(app)
      .put('/photos/2026/04/kitten.jpg')
      .set('x-api-key', API_KEY)
      .set('Content-Type', 'image/jpeg')
      .send(Buffer.from([0xff, 0xd8, 0xff]))
      .expect(200);

    const res = await request(app)
      .get('/photos/2026/04/kitten.jpg')
      .set('x-api-key', API_KEY)
      .expect(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
  });
});

describe('storage server — LIST', () => {
  it('returns S3-compatible XML and excludes .__meta__ sidecars', async () => {
    await request(app)
      .put('/listing/a.txt')
      .set('x-api-key', API_KEY)
      .set('Content-Type', 'text/plain')
      .send('a')
      .expect(200);
    await request(app)
      .put('/listing/b.txt')
      .set('x-api-key', API_KEY)
      .set('Content-Type', 'text/plain')
      .send('b')
      .expect(200);

    const res = await request(app)
      .get('/listing')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(res.headers['content-type']).toMatch(/xml/);
    expect(res.text).toContain('<Key>a.txt</Key>');
    expect(res.text).toContain('<Key>b.txt</Key>');
    expect(res.text).not.toContain('__meta__');
  });

  it('filters listing by prefix', async () => {
    await request(app)
      .put('/prefixed/sub/one.txt')
      .set('x-api-key', API_KEY)
      .send('1')
      .expect(200);
    await request(app)
      .put('/prefixed/other/two.txt')
      .set('x-api-key', API_KEY)
      .send('2')
      .expect(200);

    const res = await request(app)
      .get('/prefixed?prefix=sub')
      .set('x-api-key', API_KEY)
      .expect(200);
    expect(res.text).toContain('<Key>sub/one.txt</Key>');
    expect(res.text).not.toContain('other/two.txt');
  });
});

describe('storage server — path-based access control', () => {
  const aclDir = mkdtempSync(join(tmpdir(), 'amplify-local-storage-acl-'));
  const protectedApp = createStorageServer(
    {
      storageDir: aclDir,
      storageConfig: {
        paths: {
          'public/*': { guest: ['get'], authenticated: ['get', 'write'] },
          'private/*': { authenticated: ['get', 'write', 'delete'] },
        },
      },
    },
    API_KEY
  );

  it('allows guest (apiKey) get on public/*', async () => {
    const { mkdirSync, writeFileSync } = await import('fs');
    mkdirSync(join(aclDir, 'bucket', 'public'), { recursive: true });
    writeFileSync(join(aclDir, 'bucket', 'public', 'open.txt'), 'hello');

    await request(protectedApp)
      .get('/bucket/public/open.txt')
      .set('x-api-key', API_KEY)
      .expect(200);
  });

  it('denies guest write on public/* (guest has no write)', async () => {
    await request(protectedApp)
      .put('/bucket/public/blocked.txt')
      .set('x-api-key', API_KEY)
      .send('no')
      .expect(403);
  });

  it('denies guest access to private/*', async () => {
    await request(protectedApp)
      .get('/bucket/private/secret.txt')
      .set('x-api-key', API_KEY)
      .expect(403);
  });
});
