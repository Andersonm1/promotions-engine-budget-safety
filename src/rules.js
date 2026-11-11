// Pure rule evaluation: no database, easy to unit test.
// cart = { subtotal, deliveryFee, isFirstOrder }, all money in integer cents.

export function discountFor(promo, cart) {
  if (promo.minSpend && cart.subtotal < promo.minSpend) return 0;
  switch (promo.type) {
    case 'percent_off':
      return Math.floor((cart.subtotal * promo.percent) / 100);
    case 'free_delivery':
      return cart.deliveryFee;
    case 'first_order':
      return cart.isFirstOrder ? promo.amountOff : 0;
    default:
      throw new Error(`unknown promo type: ${promo.type}`);
  }
}

// Turns a set of promos into priced lines; item discounts together never exceed the subtotal.
function price(promos, cart) {
  let room = cart.subtotal;
  const lines = [];
  for (const promo of promos) {
    let amount = discountFor(promo, cart);
    if (promo.type !== 'free_delivery') {
      amount = Math.min(amount, room);
      room -= amount;
    }
    if (amount > 0) lines.push({ promo, amount });
  }
  return lines;
}

const total = (lines) => lines.reduce((s, l) => s + l.amount, 0);

// Picks the combination that saves the customer the most, honouring the stacking rules:
// an exclusive promo stands alone; otherwise the best promo from each stackGroup combines.
export function bestCombination(promos, cart) {
  const eligible = promos.filter((p) => discountFor(p, cart) > 0);
  const options = eligible.filter((p) => p.exclusive).map((p) => price([p], cart));

  const bestPerGroup = new Map();
  for (const p of eligible.filter((p) => !p.exclusive)) {
    const key = p.stackGroup ?? `solo:${p._id}`;
    const current = bestPerGroup.get(key);
    if (!current || discountFor(p, cart) > discountFor(current, cart)) bestPerGroup.set(key, p);
  }
  options.push(price([...bestPerGroup.values()], cart));

  return options.reduce((best, o) => (total(o) > total(best) ? o : best), []);
}
