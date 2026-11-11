# Promotions engine with budget safety

A small promotions engine on MongoDB. Promo rules (percent off over a minimum spend, free
delivery, first-order discounts, and stacking rules) live in a collection. Every capped campaign
has a budget, and **the budget holds even when 500 orders hit the same campaign at once.**

The interesting part is the budget cap. This repo puts three ways of enforcing it side by side and
load-tests them:

| Strategy | How it works | Overspends? |
|---|---|---|
| Naive read-then-write | read `budgetRemaining`, check it, `$set` the new value | **Yes**, badly |
| Optimistic locking | read value + `version`, write only if `version` is unchanged, retry on conflict | No, but wrongly refuses discounts under load |
| Atomic conditional decrement | one `updateOne({budgetRemaining: {$gte: amt}}, {$inc: {budgetRemaining: -amt}})` | No, and grants exactly what fits |

## Load test result

`npm run loadtest`: 500 concurrent checkouts, one campaign with a $1,000 cap, each order earns
$5 off, so exactly 200 orders fit. Connection pool of 100, in-memory `mongod`, Windows 10 laptop:

| strategy | granted | handed out | overspend | ledger says spent | conflicts | gave up | wall | p99 |
|---|---|---|---|---|---|---|---|---|
| naive (read-then-write) | 500 | $2,500 | **$1,500** | $10 | – | – | 233 ms | 222 ms |
| optimistic (5 retries) | 13 | $65 | $0 | $65 | 2,957 | **487** | 646 ms | 644 ms |
| optimistic (50 retries) | 200 | $1,000 | $0 | $1,000 | 5,423 | 0 | 5,792 ms | 5,249 ms |
| atomic `$inc` | **200** | **$1,000** | **$0** | $1,000 | – | – | **80 ms** | **78 ms** |

What this shows:

- **Naive overspends by 150%** and its own ledger says it spent $10 while it actually gave away
  $2,500. Lost updates hide the overspend, so you only find out from the finance report.
- **Optimistic locking is safe but has a bad failure mode.** With 5 retries, 487 customers were
  refused a discount while $935 of budget was still unspent. Raising retries to 50 fixes that
  but makes the slowest order take 5 seconds, because every order fights over one document.
- **Atomic decrement wins on every axis:** never overspends, never refuses an order that fits, one
  round trip, about 70x faster than optimistic at this contention level.

The script exits non-zero if a safe strategy overspends, if the ledger disagrees with what was
handed out, or if atomic grants anything other than exactly 200. CI runs it on every push.

### When would you pick optimistic locking?

When the new value cannot be expressed as one server-side update: for example a budget check
that needs data from several documents, or business logic that must run in the app between the
read and the write. A campaign budget is a single number going down, which is exactly what
`$inc` with a guard in the filter is for.

## Quick start

Needs Node.js 20+. No MongoDB install needed: without `MONGO_URL` the code downloads and boots a
throwaway in-memory `mongod` (about 100 MB, first run only).

```bash
npm install
```

```bash
npm test
```

```bash
npm run loadtest
```

Against a real MongoDB:

```bash
MONGO_URL=mongodb://localhost:27017 npm run loadtest
```

Change the burst size with `ORDERS=2000 npm run loadtest`.

## How it fits together

```
src/
  db.js       connect(): MONGO_URL or an in-memory mongod
  store.js    promotions collection, $jsonSchema validator, createPromotion()
  rules.js    pure rule evaluation and best-combination picking (no DB)
  budget.js   reserveAtomic, optimistic(), reserveNaive, release
  engine.js   checkout(): price the cart, reserve budget, fall back if a budget runs out
scripts/
  loadtest.js the concurrency proof
test/
  rules.test.js   stacking and eligibility
  budget.test.js  concurrency, release, validator, checkout fallback
```

### A promo document

```js
{
  name: '10% off over $50',
  type: 'percent_off',        // 'percent_off' | 'free_delivery' | 'first_order'
  percent: 10,                // percent_off
  amountOff: 1500,            // first_order, cents
  minSpend: 5000,             // optional, cents, applies to any type
  exclusive: false,           // true = never combines with anything
  stackGroup: 'item',         // at most one promo per group; no group = stacks with all
  budgetCap: 100000,          // optional, cents; absent = uncapped
  budgetRemaining: 100000,    // the number the atomic update guards
  version: 0,                 // used by optimistic locking
  active: true
}
```

All money is integer cents. The collection has a `$jsonSchema` validator, so a promo with an
unknown type or a write that would push `budgetRemaining` below zero is rejected by the server,
whichever code path tried it.

### Stacking

The engine evaluates two kinds of option and picks whichever saves the customer more:

1. each eligible **exclusive** promo on its own;
2. the best eligible promo from each **stackGroup**, combined.

So "10% off" and "welcome $15 off" in group `item` compete, and the winner stacks with
"free delivery" in group `delivery`. Item discounts together are clamped to the subtotal.

### Checkout and budget exhaustion

`checkout(db, cart)` picks the best combination and reserves budget for each capped promo in it.
If one reservation fails (its budget just ran out), the others from that attempt are released and
the next best combination without that promo is tried. The customer gets whatever is still
affordable rather than an error.

## Known limits

- **No idempotency key.** If an order service retries `checkout` after a timeout, budget can be
  reserved twice. That errs on the safe side (under-spend, not overspend). Fix: a `redemptions`
  collection with a unique index on `(orderId, promoId)` written in the same step.
- **Release is the caller's job.** Call `release()` when an order fails or is cancelled.
- **Partial budgets are refused**, not partially granted: $3 left and a $5 discount means no discount.
- **One hot document per campaign.** Atomic `$inc` handles thousands of orders a second on one
  document. Far beyond that, split the budget into N shard documents and decrement a random one.
- No coupon codes, date windows or HTTP API: promos are auto-applied library calls.

## Docs

- [Build guide](docs/BUILD_GUIDE.md): how to build this whole project from an empty folder, step by step.

## License

MIT
