# Agent instructions

Read by Codex (AGENTS.md) and Claude Code (via CLAUDE.md). Humans: this is also the short version
of the contributing guide.

## What this is

A promotions engine on MongoDB whose campaign budgets must never overspend under concurrent
orders. Node 20+, ES modules, `mongodb` driver, `node:test`. No other runtime dependencies.

```
src/rules.js   pure rule evaluation and stacking (no DB)
src/budget.js  budget reservation strategies + release
src/engine.js  checkout(): price, reserve, fall back
src/store.js   collection setup, $jsonSchema validator, indexes
scripts/loadtest.js  500-order concurrency proof
```

## Commands

- `npm test`: unit + concurrency tests (boots an in-memory mongod, no setup needed)
- `npm run loadtest`: the budget proof; exits 1 if a safe strategy overspends
- `MONGO_URL=mongodb://localhost:27017 npm run loadtest`: same, against a real server

## Rules that are not negotiable

1. **Test first.** Write the failing test, run it, and confirm it fails *for the reason you
   expect* before writing the code. Paste the failing output in your reply. No test, no change.
2. **Budget writes go through one guarded update.** Any change to `budgetRemaining` must be a
   single `updateOne` whose filter checks the condition and whose update uses `$inc`. Never read
   the value into JS, compute, and write it back. (`reserveNaive` breaks this on purpose, as the
   load test's control group. Do not copy it.)
3. **Money is integer cents.** Percentages floor. No floats for amounts.
4. **Fail toward under-spending.** When a crash or retry could leave state ambiguous, the safe
   outcome is "budget reserved but unused", never "discount given but budget not taken".
5. **Done means both pass:** `npm test` and `npm run loadtest`. Report the load-test table if
   you touched `src/budget.js` or `src/engine.js`.

## Style

- Smallest change that fully works. No new dependencies without asking.
- Pure logic stays in `src/rules.js`; anything that touches Mongo goes elsewhere.
- Comments explain *why*, one line. Known shortcuts get `// shortcut: <limit>, <when to upgrade>`.

## Git

- One logical change per commit. For test-first work, commit the red test, then the green code.
- Commit as the repo's configured identity; never put a personal email in commits or files.

## Playbooks

Reusable task prompts live in `.claude/commands/`. Claude Code runs them as slash commands
(`/tdd`, `/add-promo-type`, `/loadtest`, `/review-budget`). Codex or any other agent: open the
file and follow it as written.
