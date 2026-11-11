import { promotions } from './store.js';

// Each strategy: (db, promoId, amount) => true if `amount` cents were reserved from the campaign budget.

// Truthy, so callers that only check success still work; checkout uses it to avoid releasing a claim it doesn't own.
export const ALREADY_APPLIED = 'already-applied';

// Atomic conditional decrement: the check and the write happen inside one single-document
// update on the server, so no two orders can both see the same remaining budget.
// With an orderId, the order's claim is written in that same update: a retry can't charge twice,
// and no crash can leave a claim without its budget taken.
// shortcut: appliedOrders grows with every order (16 MB doc limit, ~500k orders); past that, move claims to a collection + transaction.
export async function reserveAtomic(db, id, amount, orderId) {
  const filter = { _id: id, budgetRemaining: { $gte: amount } };
  const update = { $inc: { budgetRemaining: -amount, version: 1 } };
  if (orderId != null) {
    filter.appliedOrders = { $ne: orderId };
    update.$push = { appliedOrders: orderId };
  }
  const r = await promotions(db).updateOne(filter, update);
  if (r.modifiedCount === 1) return true;
  if (orderId == null) return false;
  return (await promotions(db).countDocuments({ _id: id, appliedOrders: orderId })) ? ALREADY_APPLIED : false;
}

// Optimistic locking: read the doc and its version, write only if the version is unchanged,
// retry with jittered backoff on conflict. Gives up after maxRetries (a false "no budget").
export function optimistic({ maxRetries = 5 } = {}) {
  const stats = { conflicts: 0, gaveUp: 0 };
  async function reserveOptimistic(db, id, amount) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const p = await promotions(db).findOne({ _id: id }, { projection: { budgetRemaining: 1, version: 1 } });
      if (!p || p.budgetRemaining < amount) return false;
      const r = await promotions(db).updateOne(
        { _id: id, version: p.version },
        { $set: { budgetRemaining: p.budgetRemaining - amount }, $inc: { version: 1 } },
      );
      if (r.modifiedCount === 1) return true;
      stats.conflicts++;
      await new Promise((ok) => setTimeout(ok, Math.random() * 2 ** attempt));
    }
    stats.gaveUp++;
    return false;
  }
  reserveOptimistic.stats = stats;
  return reserveOptimistic;
}

// Deliberately broken read-check-write with no guard. Exists only so the load test can show the race.
export async function reserveNaive(db, id, amount) {
  const p = await promotions(db).findOne({ _id: id });
  if (!p || p.budgetRemaining < amount) return false;
  await promotions(db).updateOne({ _id: id }, { $set: { budgetRemaining: p.budgetRemaining - amount } });
  return true;
}

// Gives budget back (order failed or was cancelled). Bumps version so optimistic readers retry.
// With an orderId it only refunds while the claim exists, so a double release refunds once.
export async function release(db, id, amount, orderId) {
  const filter = { _id: id };
  const update = { $inc: { budgetRemaining: amount, version: 1 } };
  if (orderId != null) {
    filter.appliedOrders = orderId;
    update.$pull = { appliedOrders: orderId };
  }
  await promotions(db).updateOne(filter, update);
}
