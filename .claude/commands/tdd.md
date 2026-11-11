---
description: Make a behaviour change test-first (red commit, then green commit)
argument-hint: <the behaviour you want>
---

Change requested: $ARGUMENTS

Work strictly test-first:

1. **Restate** the behaviour in one sentence, and name the file(s) the test belongs in.
2. **Red.** Write the smallest test that would pass only once the behaviour exists. Run
   `npm test`. Show the failing output and explain why it fails. If it fails for the wrong reason
   (syntax error, missing import, bad setup), fix the test and run again until it fails for the
   right one. If it passes already, stop and tell me: the behaviour exists or the test is wrong.
3. **Commit red:** `test: <behaviour> (failing)`. Only the test file(s).
4. **Green.** Write the minimum code to pass. Do not touch the test you just wrote. If you
   believe the test is wrong, stop and say so instead of editing it.
5. Run `npm test` and `npm run loadtest`. Both must pass. Show the results.
6. **Commit green:** `feat:` or `fix:` with one line on why.
7. Update README / docs only where the behaviour is user-visible.
8. Report: what the test proves, what it does not, and anything you were unsure about.
