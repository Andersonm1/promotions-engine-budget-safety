import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../src/db.js';
import { createPromotion, promotions, setup } from '../src/store.js';
import { optimistic, release, reserveAtomic } from '../src/budget.js';
import { checkout } from '../src/engine.js';

let conn, db;
before(async () => {
  conn = await connect();
  db = conn.db;
  await db.dropDatabase();
  await setup(db);
});
after(() => conn.close());
beforeEach(() => Promise.all([promotions(db).deleteMany({}), db.collection('redemptions').deleteMany({})]));

const remaining = async (id) => (await promotions(db).findOne({ _id: id })).budgetRemaining;
const burst = (n, fn) => Promise.all(Array.from({ length: n }, fn));

test('atomic: 300 concurrent reservations against room for 100 grant exactly 100', async () => {
  const p = await createPromotion(db, { name: 'x', type: 'percent_off', percent: 10, budgetCap: 10_000 });
  const results = await burst(300, () => reserveAtomic(db, p._id, 100));
  assert.equal(results.filter(Boolean).length, 100);
  assert.equal(await remaining(p._id), 0);
});

test('optimistic: never overspends, and with enough retries grants everything that fits', async () => {
  const p = await createPromotion(db, { name: 'x', type: 'percent_off', percent: 10, budgetCap: 10_000 });
  const results = await burst(300, () => optimistic({ maxRetries: 1000 })(db, p._id, 100));
  const granted = results.filter(Boolean).length;
  assert.equal(granted, 100);
  assert.equal(await remaining(p._id), 0);
});

test('release gives budget back', async () => {
  const p = await createPromotion(db, { name: 'x', type: 'percent_off', percent: 10, budgetCap: 500 });
  assert.equal(await reserveAtomic(db, p._id, 500), true);
  assert.equal(await reserveAtomic(db, p._id, 1), false);
  await release(db, p._id, 500);
  assert.equal(await remaining(p._id), 500);
});

test('the collection validator rejects a negative budget', async () => {
  const p = await createPromotion(db, { name: 'x', type: 'percent_off', percent: 10, budgetCap: 100 });
  await assert.rejects(promotions(db).updateOne({ _id: p._id }, { $inc: { budgetRemaining: -101 } }));
});

test('checkout falls back to the next best combination when a budget runs out', async () => {
  const flash = await createPromotion(db, { name: 'flash', type: 'percent_off', percent: 30, exclusive: true, budgetCap: 1800 });
  await createPromotion(db, { name: '10%', type: 'percent_off', percent: 10, stackGroup: 'item' });
  await createPromotion(db, { name: 'ship', type: 'free_delivery', stackGroup: 'delivery', budgetCap: 10_000 });
  const cart = { subtotal: 6000, deliveryFee: 499, isFirstOrder: false };

  const first = await checkout(db, cart);
  assert.deepEqual(first.lines.map((l) => l.name), ['flash']);
  assert.equal(first.total, 6000 + 499 - 1800);

  const second = await checkout(db, cart);
  assert.deepEqual(second.lines.map((l) => l.name), ['10%', 'ship']);
  assert.equal(second.discount, 600 + 499);
  assert.equal(await remaining(flash._id), 0);
});

test('retrying checkout with the same orderId reserves budget once', async () => {
  const p = await createPromotion(db, { name: '10%', type: 'percent_off', percent: 10, budgetCap: 10_000 });
  const cart = { subtotal: 6000, deliveryFee: 0, isFirstOrder: false };

  const first = await checkout(db, cart, { orderId: 'order-1' });
  const retry = await checkout(db, cart, { orderId: 'order-1' }); // e.g. client timed out and resent

  assert.deepEqual(retry.lines.map((l) => [l.name, l.amount]), [['10%', 600]]);
  assert.equal(retry.total, first.total);
  assert.equal(await remaining(p._id), 10_000 - 600);
});

test('50 concurrent duplicates of one order reserve budget once', async () => {
  const p = await createPromotion(db, { name: '10%', type: 'percent_off', percent: 10, budgetCap: 10_000 });
  const cart = { subtotal: 6000, deliveryFee: 0, isFirstOrder: false };

  const results = await burst(50, () => checkout(db, cart, { orderId: 'order-2' }));

  assert.ok(results.every((r) => r.discount === 600));
  assert.equal(await remaining(p._id), 10_000 - 600);
});

test('a retry with a bigger cart gets no more discount than was charged', async () => {
  const p = await createPromotion(db, { name: '10%', type: 'percent_off', percent: 10, budgetCap: 10_000 });
  const cart = (subtotal) => ({ subtotal, deliveryFee: 0, isFirstOrder: false });

  await checkout(db, cart(6000), { orderId: 'order-3' });
  const retry = await checkout(db, cart(20_000), { orderId: 'order-3' }); // same order id, edited cart

  assert.equal(retry.discount, 600);
  assert.equal(await remaining(p._id), 10_000 - 600);
});

// Deterministic replay of a race found by /review-budget: two copies of one order (A, B) are in flight;
// A rolls back and frees X, another order takes X's budget, and B must not still hand out X.
test('a duplicate request never returns a discount its twin rolled back', async () => {
  const x = await createPromotion(db, { name: 'X', type: 'percent_off', percent: 10, stackGroup: 'a', budgetCap: 600 });
  const y = await createPromotion(db, { name: 'Y', type: 'free_delivery', stackGroup: 'b', budgetCap: 0 });
  const cart = { subtotal: 6000, deliveryFee: 499, isFirstOrder: false };
  const isX = (id) => String(id) === String(x._id);
  const gate = () => {
    let open;
    const p = new Promise((r) => (open = r));
    return { p, open };
  };
  const aClaimedX = gate(), bSawX = gate(), yToppedUp = gate();
  let aXCalls = 0, other;

  const reserveA = async (d, id, amt, o) => {
    if (isX(id) && ++aXCalls === 2) other = await checkout(db, cart, { orderId: 'other-order' });
    const ok = await reserveAtomic(d, id, amt, o);
    if (isX(id) && aXCalls === 1) {
      aClaimedX.open();
      await bSawX.p;
    }
    return ok;
  };
  const reserveB = async (d, id, amt, o) => {
    if (isX(id)) await aClaimedX.p;
    else await yToppedUp.p;
    const ok = await reserveAtomic(d, id, amt, o);
    if (isX(id)) bSawX.open();
    return ok;
  };

  const a = checkout(db, cart, { orderId: 'dup', reserve: reserveA });
  const b = checkout(db, cart, { orderId: 'dup', reserve: reserveB });
  await a;
  await promotions(db).updateOne({ _id: y._id }, { $inc: { budgetRemaining: 499 } });
  yToppedUp.open();
  const rb = await b;

  const xGiven = [rb, other].flatMap((r) => r.lines).filter((l) => isX(l.promoId)).reduce((s, l) => s + l.amount, 0);
  assert.ok(xGiven <= 600, `X handed out ${xGiven} cents against a 600 cent cap`);
});
