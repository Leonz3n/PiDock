# Async Service Execution Authority Experiment

This is a test-only single-service controller. Production Host/RPC and
`task/controlService` are unchanged and execution remains unavailable.

## Verification

```sh
pnpm --filter @pidock/shell exec vitest run src/host/service-execution-experiment.test.ts
pnpm turbo run typecheck test build lint --force
```

Thirteen tests cover real PiSessionChannel approvals and task write coordination:

- No driver refuses before minting approvals, claiming writes or changing state.
- Read-only, wrong-session and foreign-task calls never execute.
- Default-tier approvals bind the action and trusted configuration fingerprint;
  pending, rejected, stale, foreign and spent confirmations refuse execution.
- Approval spend is persisted before the execution callback. Persistence failure
  or permission/config change before side effects refuses execution.
- Mutable caller input cannot switch the action while persistence yields.
- Awaited start and stop retain the write claim; duplicate single-service
  controls, including the same session, are refused.
- Rejected starts without zero-resource proof stay owned and unconfirmed, never
  running or silently stopped. Unknown stop retains resource ownership and
  blocks unsafe restart/other-session writes.
- Natural confirmed exit clears ownership; independent task coordinators can
  proceed concurrently (not a real cross-task resource isolation acceptance).
- A real macOS supervisor start requires its own approval and a real stop needs
  a different action-bound approval; the actual service PID is gone afterward.

Final full gate: 8/8 successful, shell 1020 passed / 1 Windows-only skipped,
renderer 609 passed. No renderer/UI implementation was changed.

## Failures Retained

An earlier full gate saw the existing real macOS bridge test return native
`termination-unconfirmed` instead of exit code 3. A repeated run also observed
it during control disconnect. The bridge correctly refused confirmation; no
success condition was loosened. Fixed-field temporary diagnostics did not
isolate a cause, and 15 complete bridge repetitions followed by 40 real-only
repetitions passed. Debug instrumentation was removed. At that point this was
an unresolved intermittent native cleanup blocker; green repeats did not
remove the risk. The later anchor diagnosis/fix and original-binary reproduction
are recorded in [anchor evidence](../service-supervisor-anchor/README.md).
Redacted assertion context is retained.

Another full-gate attempt saw the unchanged renderer settings test read an
empty initial value. That test passed separately, and the final full gate passed.
No unrelated renderer changes were made.

## Remaining Boundaries

The injected channel/config fingerprint/driver must come from trusted Host
wiring; matching fields are not authentication of an arbitrary caller-provided
channel. There is no human entry, production enable flag, installed artifact
lookup or real business configuration source. The experiment relies on the
bounded supervisor driver, does not implement multi-service same-session
scheduling, and does not solve production cancellation/recovery persistence,
installed signatures, executable replacement or Windows cwd/Job Object validation.
The later [lifecycle follow-up](../service-execution-lifecycle/README.md) adds
test-only close/cancellation/checkpoints without opening production execution.
Unknown termination intentionally has no automatic reset or retry path.
