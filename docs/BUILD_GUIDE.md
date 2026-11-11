# Build guide: promotions engine with budget safety

This guide builds the whole project from an empty folder. Each step says what to make, why, and
how to check it works. The finished code is in this repo, so you can compare as you go.

**You will end up with:** promo rules stored in MongoDB, a checkout function that applies the
best legal combination of promos, campaign budget caps that hold under heavy concurrency, unit
tests, and a load test that proves the budget never overspends.

**Time:** about 2 hours.

---

## 0. Prerequisites

- **Node.js 20 or newer** (`node -v`). The project uses ES modules, `node:test` and top-level `await`.
- **Git** and a **GitHub account** if you want to publish it.
- **MongoDB is optional.** The project falls back to `mongodb-memory-server`, which downloads a
  real `mongod` binary and runs it in a temp folder. If you prefer a real server:

```bash
docker run -d --name mongo -p 27017:27017 mongo:8
```

## 1. Create the project

```bash
mkdir promotions-engine && cd promotions-engine
```

```bash
git init
```

```bash
npm init -y
```

```bash
npm install mongodb
```

```bash
npm install --save-dev mongodb-memory-server
```

Edit `package.json`: add `"type": "module"` and these scripts:

```json
"scripts": {
  "test": "node --test",
  "loadtest": "node scripts/loadtest.js"
}
```

`node --test` with no arguments finds every `test/*.test.js` file, so no test framework is needed.

Add a `.gitignore` containing `node_modules/`.

## 2. Connect to MongoDB (`src/db.js`)

One function, `connect()`, returns `{ db, close }`.

- If `MONGO_URL` is set, connect to it.
- Otherwise `await import('mongodb-memory-server')`, start a `MongoMemoryServer`, connect to its URI.
- `close()` closes the client and stops the in-memory server if one was started.

Take a `maxPoolSize` option. It matters later: the load test fires 500 checkouts at once and the
pool size decides how many actually reach the server at the same time.

The import is dynamic so production code never loads the dev-only package.

## 3. Store promo rules (`src/store.js`)

Model every promo as one document in a `promotions` collection:

| field | meaning |
|---|---|
| `type` | `percent_off`, `free_delivery` or `first_order` |
| `percent` | for `percent_off` |
| `amountOff` | for `first_order`, in cents |
| `minSpend` | optional minimum subtotal, cents |
| `exclusive` | `true` = combines with nothing |
| `stackGroup` | only one promo per group applies |
| `budgetCap` / `budgetRemaining` | optional campaign budget, cents |
| `version` | counter for optimistic locking |
| `active` | on/off switch |

**Use integer cents for money.** Floating-point dollars produce off-by-a-cent bugs that are
impossible to reconcile against a budget.

Write three exports:

1. `promotions(db)`: returns the collection (keeps the name in one place).
2. `setup(db)`: creates the collection with a `$jsonSchema` validator, or updates the validator
   with `collMod` if the collection already exists. Restrict `type` with `enum`, make money fields
   `bsonType: ['int', 'long']` with `minimum: 0`.
3. `createPromotion(db, promo)`: fills defaults (`active: true`, `exclusive: false`, `version: 0`,
   `budgetRemaining = budgetCap`) and inserts.

The `minimum: 0` on `budgetRemaining` is a second safety net. Even a buggy code path that
decrements without checking gets its write rejected by the server.

## 4. Evaluate rules (`src/rules.js`)

Keep this file free of database code. Pure functions are fast to test and easy to reason about.

**`discountFor(promo, cart)`**, with `cart = { subtotal, deliveryFee, isFirstOrder }`:

- return 0 if `subtotal < minSpend`;
- `percent_off`: `Math.floor(subtotal * percent / 100)`. Floor, so you never give away a
  fraction of a cent more than promised;
- `free_delivery`: `deliveryFee`;
- `first_order`: `amountOff` if `isFirstOrder`, else 0;
- throw on an unknown type.

**`bestCombination(promos, cart)`** implements the stacking rules:

1. Keep only promos with a discount above zero.
2. Option set A: every exclusive promo, each on its own.
3. Option set B: for each `stackGroup`, the non-exclusive promo with the biggest discount; a promo
   with no group is its own group. Combine them all.
4. Price each option. Clamp item discounts so their sum never exceeds the subtotal (delivery is
   separate). Return the option with the largest total.

Return lines of `{ promo, amount }`.

**Check it:** write `test/rules.test.js` with cases for min spend, first order, two groups
stacking, two promos in one group (better one wins), exclusive beating and losing to a stack, and
the subtotal clamp. Run `npm test`.

## 5. Reserve budget: the hard part (`src/budget.js`)

Every strategy has the same shape: `(db, promoId, amount) => Promise<boolean>`, true if the
amount was taken from the campaign budget. Same shape means the engine and the load test can
swap them freely.

### 5a. Naive read-then-write (the control group)

```js
const p = await promotions(db).findOne({ _id: id });
if (p.budgetRemaining < amount) return false;
await promotions(db).updateOne({ _id: id }, { $set: { budgetRemaining: p.budgetRemaining - amount } });
return true;
```

This is wrong, and you build it on purpose. Between the `findOne` and the `updateOne`, hundreds of
other orders read the same `budgetRemaining`, all pass the check, and all write nearly the same
value. Every order gets the discount and most of the decrements are lost.

### 5b. Optimistic locking

Read `budgetRemaining` and `version`. Write with the version in the filter:

```js
updateOne({ _id: id, version: p.version },
          { $set: { budgetRemaining: p.budgetRemaining - amount }, $inc: { version: 1 } })
```

If `modifiedCount` is 0, someone else wrote first: wait a random, growing delay
(`Math.random() * 2 ** attempt` ms) and try again, up to `maxRetries`. Wrap it in a factory
`optimistic({ maxRetries })` and hang a `stats` object (`conflicts`, `gaveUp`) on the returned
function so the load test can report them.

This never overspends, because a write only lands if nothing changed since the read. Its weakness
is that under heavy contention most attempts conflict, and once retries run out the order is
refused a discount **even though budget remains**.

### 5c. Atomic conditional decrement (the answer)

```js
const r = await promotions(db).updateOne(
  { _id: id, budgetRemaining: { $gte: amount } },
  { $inc: { budgetRemaining: -amount, version: 1 } },
);
return r.modifiedCount === 1;
```

MongoDB applies the filter and the update to one document atomically. There is no gap between the
check and the write for another order to slip into, and no retry loop. Bumping `version` too keeps
optimistic readers correct if both strategies ever touch the same document.

### 5d. Release

`release(db, id, amount)` does `$inc: { budgetRemaining: amount, version: 1 }`. Call it when an
order fails or is cancelled.

**Check it:** write `test/budget.test.js`. Fire 300 concurrent `reserveAtomic` calls of 100 cents
at a 10,000 cent cap and assert exactly 100 succeed and `budgetRemaining` is 0. Do the same for
optimistic with a high retry count. Assert the validator rejects a decrement below zero.

## 6. Checkout (`src/engine.js`)

`checkout(db, cart, { reserve = reserveAtomic })`:

1. Load active promos.
2. Loop:
   - `bestCombination` over the promos not yet excluded;
   - reserve budget for each capped line (skip the call for uncapped promos);
   - if every reservation succeeded, return `{ lines, discount, total }`;
   - otherwise release the reservations made in this attempt, exclude the promo whose budget ran
     out, and go round again.

The loop always ends: each failed pass excludes one more promo, and an empty combination needs no
reservations. The effect is graceful fallback. When the flash sale budget is gone, the customer
still gets "10% off + free delivery" instead of nothing.

**Check it:** a test with an exclusive promo whose budget fits exactly one order. The first checkout
gets the exclusive promo; the second falls back to the stack.

## 7. Prove it under load (`scripts/loadtest.js`)

Set up a campaign that fits an exact number of orders, so the right answer is obvious:

- cap $1,000 (`100_000` cents);
- 10% off a $50 cart = $5 per order, so exactly **200** orders fit;
- fire **500** checkouts with `Promise.all`, all at once.

Run that once per strategy (naive, optimistic with 5 retries, optimistic with 50, atomic). For each,
record:

- how many orders got a discount, total discount handed out, overspend;
- what the budget document says was spent (`cap - budgetRemaining`);
- optimistic conflicts and give-ups;
- wall time, p50 and p99 latency.

Print a `console.table`. Then **assert**, and `process.exit(1)` on failure:

- for every safe strategy: handed out ≤ cap, and handed out = what the document says was spent;
- for atomic: exactly 200 orders granted.

Naive is not asserted. It is there to show the race is real on your machine. If naive does not
overspend, your test is not concurrent enough and proves nothing about the others.

Typical output: naive grants 500 orders and overspends $1,500 while its own ledger says $10;
optimistic with 5 retries refuses 487 orders that fit; optimistic with 50 retries is correct but
p99 is about 5 seconds; atomic grants exactly 200 in about 80 ms. See the README for a full table.

## 8. Continuous integration (`.github/workflows/ci.yml`)

One job on `ubuntu-latest`: checkout, `actions/setup-node` with Node 22, `npm ci`, `npm test`,
`npm run loadtest`. No MongoDB service is needed because of the in-memory fallback. Every push now
re-proves the budget guarantee.

## 9. Publish to GitHub

```bash
git add -A
```

```bash
git commit -m "Promotions engine with budget-safe campaign caps"
```

```bash
gh repo create promotions-engine-budget-safety --public --source . --push
```

## 10. Safe retries, built test-first

An order service that times out will resend the checkout. Without protection, each resend takes
budget again. Build this one test-first (`/tdd` in `.claude/commands/` walks an agent through it):

1. **Red.** Two tests in `test/budget.test.js`: a checkout followed by a retry with the same
   `orderId` leaves the budget charged once; 50 concurrent copies of one order are charged once and
   all get the discount. Run them and watch them fail: the retry leaves 8,800 instead of 9,400, and
   the 50 copies drain the budget so some get nothing. Commit.
2. **Green.** In `reserveAtomic`, when an `orderId` is given, add
   `'appliedOrders.orderId': { $ne: orderId }` to the filter and
   `$push: { appliedOrders: { orderId, amount } }` to the update. If nothing matched, look the
   claim up and return `{ alreadyCharged: amount }`. In `checkout`, pass `orderId` through, cap
   an already-charged line at the amount actually charged, and **don't release claims on
   rollback when there is an `orderId`**. Make `release` guarded by the claim and `$pull` it.
3. **Review.** Run `/review-budget` on the diff. On this repo it found two overspend paths in a
   first version of step 2, each now covered by a test:
   - A duplicate request rolled back and released a claim that its twin then returned. The test
     replays that race deterministically by gating the injected `reserve` function.
   - A retry with an edited cart got the new, bigger discount while only the old one was charged.

Why not a separate `redemptions` collection with a unique index? Each concurrent duplicate would
reserve budget first and only then hit the duplicate-key error. Fifty copies briefly hold fifty
times the discount, and on a small campaign that drains the cap and refuses real customers. Putting
the claim in the same single-document update as the decrement removes that window.

## 11. Agent setup

Commit `AGENTS.md` (project rules for Codex and other agents), a one-line `CLAUDE.md` that imports
it with `@AGENTS.md`, and reusable prompts in `.claude/commands/`. See
[AGENT_WORKFLOW.md](AGENT_WORKFLOW.md).

## 12. Where to take it next

- **Coupon codes and date windows:** add `code`, `startsAt`, `endsAt` to the schema and filter in
  the `find` inside `checkout`.
- **Extreme throughput:** split one campaign's budget across N shard documents and decrement a
  random shard with the same atomic update; fall through to another shard when one is empty.
- **HTTP API:** wrap `checkout` in a single POST route.
