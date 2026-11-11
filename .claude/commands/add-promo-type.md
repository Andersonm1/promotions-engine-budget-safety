---
description: Add a new promotion type, test-first
argument-hint: <type name and how its discount is computed>
---

New promo type: $ARGUMENTS

Follow `/tdd`. The places a new type must reach:

1. `test/rules.test.js`: eligibility case, amount case, and how it stacks with an existing type. Red first.
2. `src/rules.js`: a `case` in `discountFor`. Integer cents, floor any percentage. Decide
   whether it is an item discount (clamped to the subtotal in `price`) or not, like delivery.
3. `src/store.js`: add the type to the validator `enum` and any new fields to `properties`.
4. `README.md`: the promo document example and the type list.

Do not touch `src/budget.js`: budgets are per campaign, not per type. If the new type seems to
need a budget change, stop and explain why.
