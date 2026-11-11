import { promotions } from './store.js';
import { bestCombination } from './rules.js';
import { reserveAtomic, release } from './budget.js';

// Prices a cart and reserves campaign budget for every promo applied.
// If a promo's budget runs out mid-checkout, its siblings are released and the next best
// combination without it is tried, so the customer still gets whatever is affordable.
export async function checkout(db, cart, { reserve = reserveAtomic } = {}) {
  const active = await promotions(db).find({ active: true }).toArray();
  const excluded = new Set();

  for (;;) {
    const lines = bestCombination(active.filter((p) => !excluded.has(String(p._id))), cart);
    const reserved = [];
    let failed = null;
    for (const line of lines) {
      const ok = line.promo.budgetCap == null || (await reserve(db, line.promo._id, line.amount));
      if (!ok) {
        failed = line;
        break;
      }
      reserved.push(line);
    }

    if (!failed) {
      const discount = reserved.reduce((s, l) => s + l.amount, 0);
      return {
        lines: reserved.map((l) => ({ promoId: l.promo._id, name: l.promo.name, amount: l.amount })),
        discount,
        total: cart.subtotal + cart.deliveryFee - discount,
      };
    }

    await Promise.all(
      reserved.filter((l) => l.promo.budgetCap != null).map((l) => release(db, l.promo._id, l.amount)),
    );
    excluded.add(String(failed.promo._id));
  }
}
