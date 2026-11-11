# How this repo was built with an agent

**Tool:** Claude Code (desktop app, Claude Opus 5.5). **Human role:** set the requirements, set the
rules, decided what "done" means, and pushed for a test-first workflow.

## The setup that's committed

| File | What it does |
|---|---|
| [`AGENTS.md`](../AGENTS.md) | Rules for any agent (Codex reads it directly): test first, budget writes only through one guarded `$inc`, integer cents, fail toward under-spending, done means `npm test` and `npm run loadtest` both pass |
| [`CLAUDE.md`](../CLAUDE.md) | One line, `@AGENTS.md`, so Claude Code and Codex share one source of truth |
| [`/tdd`](../.claude/commands/tdd.md) | Test-first loop: restate, red (and prove it fails for the *right* reason), commit red, minimal green without touching the test, run both suites, commit green |
| [`/add-promo-type`](../.claude/commands/add-promo-type.md) | Test-first checklist of every place a new promo type must reach |
| [`/loadtest`](../.claude/commands/loadtest.md) | Runs the load test and makes the agent interpret it, including "did the control group actually fail?" |
| [`/review-budget`](../.claude/commands/review-budget.md) | Review checklist for concurrency hazards: read-modify-write, unguarded decrements, crash ordering, double release, retries |
| [`.claude/settings.json`](../.claude/settings.json) | Pre-approves test commands; `git push` always asks |

## Timeline

1. **First build** (`183dca5`), from one prompt: *"Store promo rules in MongoDB … budget caps under
   concurrent orders … compare optimistic locking with atomic decrements, and write a load test
   that proves your approach works."* The agent produced the engine, 12 tests, the load test,
   docs and CI.
2. **Agent setup** (`6eb5dd6`): the human asked for the workflow to be explicit and test-first.
3. **Red** (`00f3949`): `/tdd` applied to the biggest known limit, retried checkouts charging a
   budget twice. Both new tests failed for the expected reason:
   ```
   ✖ retrying checkout with the same orderId reserves budget once
     actual: 8800, expected: 9400
   ✖ 50 concurrent duplicates of one order reserve budget once
     actual: false, expected: true      (some copies got no discount: budget drained)
   ```
4. **Green** (`17f21d5`): 14/14 tests pass, load test passes, test file untouched.

## What the agent did well

- **Checked the environment before designing.** No MongoDB installed and Docker not running, so it
  added an in-memory `mongod` fallback. Tests and CI need zero setup as a result.
- **Built a control group.** It wrote a deliberately broken read-then-write strategy so the load
  test proves the race is real. Without it, "the safe strategies passed" would prove nothing.
- **Made the claim falsifiable.** The comparison is assertions, not a chart: the script exits 1 if
  a safe strategy overspends, and CI runs it on every push.
- **Measured the trade-off.** Optimistic locking with 5 retries refused 487 of 500 orders while
  $935 of budget was unspent. That's a concrete reason to choose atomic decrements.
- **Thought before coding the fix.** The obvious idempotency design (a `redemptions` collection
  with a unique index) would have failed the 50-duplicate test: each copy reserves budget before
  it discovers its twin. The agent put the claim inside the same atomic update instead, and wrote
  the reason in the commit message.
- **Kept personal data out.** It committed with the GitHub noreply address, not a personal email.

## Where a human had to step in

- **Test-first wasn't automatic.** In the first build the agent wrote tests in the same pass as
  the code, after it. The human required test-first. That became rule 1 in `AGENTS.md`, and `/tdd`
  forces a red commit before any code.
- **Scope.** The agent shipped idempotency as a documented "known limit" rather than building it
  unasked. Building it was a human call.
- **Judgement calls it surfaced but didn't make:** refusing (not partially granting) a discount
  when the budget is short; the `appliedOrders` array's ~500k-orders-per-campaign ceiling; and
  over-reserving when a retry picks a different combination. All are in the README's known limits.

## How the output was checked

- **Red before green:** each new test was shown failing, for the stated reason, before code existed.
- **Test not moved to fit the code:** `git diff --stat test/` was empty during the green step.
- **Load test with invariants:** amount handed out ≤ cap; handed out = what the budget document
  says was spent; atomic grants exactly the 200 orders that fit; naive *must* visibly overspend.
- **A second environment:** GitHub Actions runs the tests and the load test on Linux, so it isn't
  only "works on my laptop".
- **Interleavings walked before coding:** while designing the idempotency fix, the agent traced
  crash ordering and concurrent duplicates by hand, the cases `/review-budget` now lists. That
  showed a retried request must never release a claim it doesn't own, which is why `reserveAtomic`
  returns `ALREADY_APPLIED` and checkout skips those lines when rolling back. `/review-budget` was
  written from that pass; it hasn't yet been run as a separate review.
