// Promo rules live in the `promotions` collection. Money is integer cents everywhere.
const money = { bsonType: ['int', 'long'], minimum: 0 };

const validator = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['name', 'type', 'active', 'exclusive', 'version'],
    properties: {
      name: { bsonType: 'string' },
      type: { enum: ['percent_off', 'free_delivery', 'first_order'] },
      active: { bsonType: 'bool' },
      percent: { bsonType: ['int', 'double'], minimum: 0, maximum: 100 },
      minSpend: money,
      amountOff: money,
      exclusive: { bsonType: 'bool' }, // true = never combines with any other promo
      stackGroup: { bsonType: 'string' }, // at most one promo per group applies; no group = stacks freely
      budgetCap: money, // absent = uncapped
      budgetRemaining: money, // server rejects any write that would take it below zero
      version: { bsonType: ['int', 'long'] },
      // orders already charged and how much, for idempotent retries
      appliedOrders: {
        bsonType: 'array',
        items: { bsonType: 'object', required: ['orderId', 'amount'], properties: { orderId: { bsonType: 'string' }, amount: money } },
      },
    },
  },
};

export const promotions = (db) => db.collection('promotions');

export async function setup(db) {
  const exists = await db.listCollections({ name: 'promotions' }).hasNext();
  if (exists) await db.command({ collMod: 'promotions', validator });
  else await db.createCollection('promotions', { validator });
}

export async function createPromotion(db, promo) {
  const doc = { active: true, exclusive: false, version: 0, ...promo };
  if (doc.budgetCap != null) doc.budgetRemaining ??= doc.budgetCap;
  await promotions(db).insertOne(doc);
  return doc;
}
