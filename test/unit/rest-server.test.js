import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createRestServer } from '../../src/services/rest/server.js';

const app = createRestServer({
  rest: {
    ordersApiEndpoint: {
      'GET /': { status: 200, body: { ok: true, endpoint: 'orders' } },
      'POST /': { status: 201, body: { id: 'mock-order-1', status: 'PENDING' } },
      'GET /:id': { status: 200, body: { id: ':id', status: 'DELIVERED' } },
      'POST /:id/nested/:kind': {
        status: 200,
        body: { id: ':id', kind: ':kind' },
      },
    },
    paymentsApiEndpoint: {
      'GET /charge': {
        status: 200,
        body: { success: true },
        headers: { 'x-mock-source': 'amplify-local' },
      },
    },
    fnEndpoint: {
      'GET /dynamic': (req, res) => res.status(202).json({ q: req.query.q }),
    },
  },
});

describe('REST mock server', () => {
  it('serves a static configured GET', async () => {
    const res = await request(app).get('/ordersApiEndpoint/').expect(200);
    expect(res.body).toEqual({ ok: true, endpoint: 'orders' });
  });

  it('honors the configured status', async () => {
    const res = await request(app).post('/ordersApiEndpoint/').send({}).expect(201);
    expect(res.body.status).toBe('PENDING');
  });

  it('substitutes :param placeholders in string values', async () => {
    const res = await request(app).get('/ordersApiEndpoint/abc123').expect(200);
    expect(res.body).toEqual({ id: 'abc123', status: 'DELIVERED' });
  });

  it('substitutes multiple params in nested structures', async () => {
    const res = await request(app)
      .post('/ordersApiEndpoint/99/nested/cat')
      .send({})
      .expect(200);
    expect(res.body).toEqual({ id: '99', kind: 'cat' });
  });

  it('sets configured response headers', async () => {
    const res = await request(app).get('/paymentsApiEndpoint/charge').expect(200);
    expect(res.headers['x-mock-source']).toBe('amplify-local');
  });

  it('accepts a function as the response config', async () => {
    const res = await request(app).get('/fnEndpoint/dynamic?q=hello').expect(202);
    expect(res.body).toEqual({ q: 'hello' });
  });

  it('catch-all returns a mock descriptor for unknown endpoints', async () => {
    const res = await request(app).get('/unknownEndpoint/foo/bar').expect(200);
    expect(res.body).toMatchObject({
      message: 'mock',
      endpoint: 'unknownEndpoint',
      method: 'GET',
      path: '/foo/bar',
    });
  });

  it('CORS preflight returns 204 with allow headers', async () => {
    const res = await request(app).options('/ordersApiEndpoint/').expect(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });
});
