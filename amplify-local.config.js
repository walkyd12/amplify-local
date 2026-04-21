export default {
  users: [
    {
      email: 'admin@test.local',
      sub: 'admin-sub-0001',
      password: 'Admin1!',
      groups: ['admins'],
    },
    {
      email: 'user@test.local',
      sub: 'user-sub-0001',
      password: 'User1!',
      groups: [],
    },
  ],
  rest: {
    ordersApiEndpoint: {
      'GET /': { status: 200, body: { ok: true, endpoint: 'orders' } },
      'POST /': { status: 201, body: { id: 'mock-order-1', status: 'PENDING' } },
      'GET /:id': { status: 200, body: { id: ':id', status: 'DELIVERED' } },
    },
  },
};
