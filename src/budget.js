import { promotions } from './store.js';

// Each strategy: (db, promoId, amount) => true if `amount` cents were reserved from the campaign budget.

// Atomic conditional decrement: the check and the write happen inside one single-document
// update on the server, so no two orders can both see the same remaining budget.
export async function reserveAtomic(db, id, amount) {
  const r = await promotions(db).updateOne(
    { _id: id, budgetRemaining: { $gte: amount } },
    { $inc: { budgetRemaining: -amount, version: 1 } },
  );
  return r.modifiedCount === 1;
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
export async function release(db, id, amount) {
  await promotions(db).updateOne({ _id: id }, { $inc: { budgetRemaining: amount, version: 1 } });
}
