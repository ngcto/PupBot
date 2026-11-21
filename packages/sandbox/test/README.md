# Why these tests exist

Two properties the harness above this package depends on, both proven here rather
than asserted in the report:

1. **A tool's full result never reaches the model.** `keeps a tool's full result out
   of the model's view` gives the program 10,000 rows and asserts what comes back is
   two lines under 120 characters. That is the token argument, and it is this
   package's responsibility, not the caller's.
2. **The VM has no ambient capability.** `reports every capability the VM does not
   have` asserts `setTimeout`, `fetch`, `process`, `require` and `WebAssembly` are
   all `undefined` inside. If a future dependency registers one, this fails.

And three failure modes that exist because this is a product, not a benchmark:

- a program waiting on a promise nothing can settle **fails immediately**
  (`kind: "stall"`), because the VM has no timers or I/O and the alternative is a
  bot that looks frozen;
- a tight loop is stopped by the interrupt handler and reported as `timeout`, not as
  an error in the program;
- a program that exceeds its call budget reports `limit` and names the budget.
