import { promotions } from './store.js';
import { bestCombination } from './rules.js';
import { reserveAtomic, release } from './budget.js';

// Prices a cart and reserves campaign budget for every promo applied.
// If a promo's budget runs out mid-checkout, its siblings are released and the next best
// combination without it is tried, so the customer still gets whatever is affordable.
// Pass orderId to make retries safe: the same order is charged against a budget at most once.
export async function checkout(db, cart, { reserve = reserveAtomic, orderId } = {}) {
  const active = await promotions(db).find({ active: true }, { projection: { appliedOrders: 0 } }).toArray();
  const excluded = new Set();

  for (;;) {
    const lines = bestCombination(active.filter((p) => !excluded.has(String(p._id))), cart);
    const reserved = [];
    let failed = null;
    for (const line of lines) {
      if (line.promo.budgetCap == null) {
        reserved.push(line);
        continue;
      }
      const ok = await reserve(db, line.promo._id, line.amount, orderId);
      if (!ok) {
        failed = line;
        break;
      }
      // Never hand out more than this order was actually charged (a retry may carry an edited cart).
      reserved.push(ok.alreadyCharged == null ? line : { ...line, amount: Math.min(line.amount, ok.alreadyCharged) });
    }

    if (!failed) {
      const discount = reserved.reduce((s, l) => s + l.amount, 0);
      return {
        lines: reserved.map((l) => ({ promoId: l.promo._id, name: l.promo.name, amount: l.amount })),
        discount,
        total: cart.subtotal + cart.deliveryFee - discount,
      };
    }

    // An order's claims are shared by every in-flight copy of that order, so one copy rolling back
    // could pull a claim its twin is about to return. With an orderId, keep them.
    // shortcut: a kept claim the final combination doesn't use stays reserved (under-spend) until the order is cancelled.
    if (orderId == null) {
      await Promise.all(reserved.filter((l) => l.promo.budgetCap != null).map((l) => release(db, l.promo._id, l.amount)));
    }
    excluded.add(String(failed.promo._id));
  }
}
