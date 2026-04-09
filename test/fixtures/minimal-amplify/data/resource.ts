import { type ClientSchema, a, defineData } from '@aws-amplify/backend';

const StatusEnum = a.enum(['ACTIVE', 'INACTIVE', 'PENDING']);

const schema = a.schema({
  Category: a
    .model({
      name: a.string().required(),
      description: a.string(),
      products: a.hasMany('Product', 'categoryId'),
    })
    .authorization((allow) => [
      allow.publicApiKey().to(['read']),
      allow.group('admins').to(['create', 'read', 'update', 'delete']),
    ]),

  Product: a
    .model({
      name: a.string().required(),
      price: a.float().required(),
      description: a.string(),
      sku: a.string().required(),
      inStock: a.boolean(),
      tags: a.string().array(),
      metadata: a.json(),
      status: StatusEnum,
      categoryId: a.id(),
      category: a.belongsTo('Category', 'categoryId'),
      reviews: a.hasMany('Review', 'productId'),
    })
    .secondaryIndexes((index) => [
      index('categoryId'),
      index('sku').name('bySkuIndex'),
    ])
    .authorization((allow) => [
      allow.publicApiKey().to(['read']),
      allow.group('admins').to(['create', 'read', 'update', 'delete']),
    ]),

  Review: a
    .model({
      content: a.string().required(),
      rating: a.integer().required(),
      productId: a.id().required(),
      product: a.belongsTo('Product', 'productId'),
    })
    .authorization((allow) => [
      allow.publicApiKey().to(['read']),
      allow.owner(),
      allow.group('admins').to(['create', 'read', 'update', 'delete']),
    ]),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'apiKey',
    apiKeyAuthorizationMode: {
      expiresInDays: 30,
    },
  },
});
