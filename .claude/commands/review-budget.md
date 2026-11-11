---
description: Review the current diff for budget-safety hazards
---

Review `git diff` (or `git diff HEAD~1` if the tree is clean) for anything that could let a
campaign overspend or lose track of its budget. Read the surrounding code, not only the diff.

Check specifically:

1. **Read-modify-write:** any value of `budgetRemaining` read into JS and written back.
2. **Unguarded decrement:** an `$inc` on `budgetRemaining` whose filter does not check `$gte`.
3. **Check-then-act across calls:** a `findOne` used to decide whether a later write is allowed.
4. **Crash ordering:** if the process died between two awaits, which way would the budget be
   wrong? It must only ever be wrong toward under-spending.
5. **Release paths:** every reservation that is not kept is released, exactly once.
6. **Retries:** can a retried request reserve twice?
7. **Floats:** any money that is not an integer number of cents.
8. **Tests:** is the new behaviour covered by a concurrent test, not only a sequential one?

For each finding: file:line, the concrete interleaving that breaks it, and the fix. If nothing
is wrong, say so plainly; do not invent findings.
