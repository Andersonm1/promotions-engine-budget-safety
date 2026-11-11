// Fires ORDERS checkouts at once at one capped campaign, once per budget strategy,
// then checks the money: discount actually handed out must never exceed the cap.
import { connect } from '../src/db.js';
import { createPromotion, promotions, setup } from '../src/store.js';
import { optimistic, reserveAtomic, reserveNaive } from '../src/budget.js';
import { checkout } from '../src/engine.js';

const ORDERS = Number(process.env.ORDERS) || 500;
const CAP = 100_000; // $1,000 budget
const cart = { subtotal: 5_000, deliveryFee: 0, isFirstOrder: false }; // 10% off => $5 each => room for exactly 200 orders
const FITS = CAP / 500;

const strategies = {
  'naive (read-then-write)': reserveNaive,
  'optimistic (5 retries)': optimistic({ maxRetries: 5 }),
  'optimistic (50 retries)': optimistic({ maxRetries: 50 }),
  'atomic $inc': reserveAtomic,
};

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

const { db, close } = await connect({ maxPoolSize: 100 });
await db.dropDatabase();
await setup(db);

const rows = [];
let failed = false;
for (const [name, reserve] of Object.entries(strategies)) {
  await promotions(db).deleteMany({});
  const promo = await createPromotion(db, { name: '10% off over $30', type: 'percent_off', percent: 10, minSpend: 3_000, budgetCap: CAP });

  const latencies = [];
  const start = performance.now();
  const results = await Promise.all(
    Array.from({ length: ORDERS }, async () => {
      const t = performance.now();
      const r = await checkout(db, cart, { reserve });
      latencies.push(performance.now() - t);
      return r;
    }),
  );
  const wall = performance.now() - start;
  latencies.sort((a, b) => a - b);

  const handedOut = results.reduce((s, r) => s + r.discount, 0);
  const { budgetRemaining } = await promotions(db).findOne({ _id: promo._id });
  const granted = results.filter((r) => r.discount > 0).length;
  const safe = handedOut <= CAP && handedOut === CAP - budgetRemaining;

  rows.push({
    strategy: name,
    granted,
    'fits in cap': FITS,
    'handed out $': handedOut / 100,
    'overspend $': Math.max(0, handedOut - CAP) / 100,
    'ledger says spent $': (CAP - budgetRemaining) / 100,
    conflicts: reserve.stats?.conflicts ?? '-',
    'gave up': reserve.stats?.gaveUp ?? '-',
    'wall ms': Math.round(wall),
    'p50 ms': +pct(latencies, 50).toFixed(1),
    'p99 ms': +pct(latencies, 99).toFixed(1),
    safe,
  });

  if (reserve === reserveNaive) continue; // expected to be unsafe; it is the control group
  if (!safe) failed = true;
  if (reserve === reserveAtomic && granted !== FITS) failed = true; // atomic must also not leave budget on the table
}

console.log(`\n${ORDERS} concurrent orders against a $${CAP / 100} campaign (room for ${FITS})\n`);
console.table(rows);
await close();

if (failed) {
  console.error('\nFAIL: a safe strategy overspent or lost track of the budget');
  process.exit(1);
}
console.log('\nPASS: optimistic and atomic never overspent; atomic granted exactly what fits');
