---
description: Run the concurrency load test and interpret it
argument-hint: "[order count, default 500]"
---

Run `ORDERS=$ARGUMENTS npm run loadtest` (plain `npm run loadtest` if no count was given).

Then answer, using the numbers in the table:

1. Did it print PASS? If not, which invariant broke, and for which strategy?
2. Did **naive** overspend? If it did not, the burst was not concurrent enough to prove anything:
   say so and suggest a bigger `ORDERS` or a smaller pool.
3. For each optimistic row: how many orders were refused while budget remained
   (`fits in cap - granted`), and what did the retries cost in p99?
4. Is atomic still exactly `fits in cap`, with the lowest p99?

Do not edit the README table unless I ask; numbers vary by machine.
