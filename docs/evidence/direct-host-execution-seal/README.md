# Direct Host Execution Seal And Derived Retention

Follow-up to [installed RPC admission](../host-task-admission/README.md) for
[issue #7](https://github.com/Leonz3n/PiDock/issues/7). This is a bounded direct
Host guard, not complete native-resource discovery or service enablement.

## Contract

A legal installed task quit now synchronously calls `TaskWorkspaceHost.sealExecution()`
as well as sealing RPC/SDK-turn admission. Direct turns, approval execution,
write claims, derived registration, scheduled evaluation/run-now and Provider
installation refuse after seal, before their mutation/execution callbacks.
An installed SDK context is synchronously sealed too, so a retained SDK router
cannot admit another model request. A pending Provider bootstrap is disposed
rather than attached if it finishes after execution seal.

Existing write claims can settle; rejection of pending approval and explicit
trusted derived settlement remain available. Cancel on a sealed session refuses
to erase derived registrations or ordinary unsettled write claims. The settlement
check requires sealing first. Installed quit checks these registrations after
SDK/turn/RPC drain, before lifecycle cancellation can discard them. Nonempty
registrations refuse with `task-derived-executions-unconfirmed` or
`task-write-claims-unconfirmed`. Only claims tied to a channel still in approval
and the Host's pending-approval map are exempt: their planned tool has not run.

`dispose()` is cached, seals execution, and only clears channels, approval/write
claims and shared-path holdings after confirmed SDK shutdown. A known derived
registration or ordinary unsettled write claim at disposal entry keeps metadata/
ownership and fails the cached receipt even if an internal caller later settles
it. SDK shutdown
failure also preserves metadata. Successful disposal is asynchronous; callers
must await its promise before treating metadata cleanup as complete.

`endDerivedExecution()` is an existing trusted internal metadata operation, NOT
a native-exit proof API. Its caller still needs a future trusted actual-resource
adapter before it can represent a real child exit. Absence of registered children
is not complete inventory proof. Cleanup outside the sealed phase retains the
legacy modeled cancellation behavior; real child/tool cancellation integration
remains unfinished. Returned legacy PiSessionChannel/tool ports are not wholly
sealed by these class guards, nor are all metadata/configuration helpers newly
gated. Installed RPC admission remains the broader task-operation barrier.

## Verification

```sh
pnpm --filter @pidock/shell exec vitest run src/host/task-execution-seal.test.ts src/host/task-host.test.ts src/host/sdk-provider-context.test.ts
pnpm turbo run typecheck test build lint --force
pnpm --filter @pidock/shell smoke:direct-execution-seal
pnpm --filter @pidock/shell smoke:task-admission
pnpm --filter @pidock/shell smoke:active-turn-quit
pnpm --filter @pidock/shell smoke:active-model-report
```

Six direct guard tests and two Provider/disposal tests cover callback/state
preservation, late admission, claims settling, pending approval refusal, scheduler
refusal, SDK handle sealing, late bootstrap disposal, SDK-failed metadata retention,
known derived/write-claim refusal and sticky disposal despite late settlement.
The focused suite passes 75 tests; full final gate passes 8/8, shell 92 files,
1185 passed / 1 existing Windows-only skip; renderer 77 files, 609 passed.
Logs: `/tmp/pidock-direct-seal-focused-final3.log`,
`/tmp/pidock-direct-seal-gate-final3.log`.

Initial missing-method red is `/tmp/pidock-direct-seal-red.log`; the next partial
implementation failed a wall-clock-dependent snapshot assertion, corrected by
using a fixed fixture clock (`/tmp/pidock-direct-seal-first-green.log`, not green
despite filename). Approval/scheduler/disposal missing guards reproduced in
`/tmp/pidock-direct-seal-derived-red.log`. The optional test-inclusive tsc caught
an untyped Promise in the new Provider test; fixed. Final extra tsc still fails
with the same 72 baseline diagnostics after normalizing source line shifts:
`/tmp/pidock-direct-seal-test-types-final3.log`. It is not a passing gate.

Actual macOS arm64 Electron 44.4.3 / Node 24.21.0 direct probe imports compiled
TaskWorkspaceHost into a test Electron main, creates a real SDK Worker/AgentSession
and loopback SSE request (zero tools). It verifies an active partial stream,
retained router refusing a late prompt, exactly one Provider request, model
cancellation, HTTP close and actual Worker exit. An explicitly metadata-only
child witness remains held across failed disposal; late internal settlement does
not repair that receipt. It does NOT spawn/verify a native derived child. SDK
JSONL excludes the synthetic credential. `DIRECT_EXECUTION_SEAL_OK` in
`/tmp/pidock-direct-seal-electron-final3.log`. Forced termination in fixture
cleanup is not release authorization.

Installed Host RPC admission, three active-turn quit scenes and six experimental
active-model/report scenes pass again; logs
`/tmp/pidock-direct-seal-{admission,quit,report}-regression-final3.log`. These are
separate evidence from the direct-class probe. No independent subagent approval
exists; the previously recorded harness infrastructure blocker remains unresolved.

## Follow-Up

[Retained legacy channel admission seal](../legacy-channel-admission-seal/README.md)
seals returned PiSessionChannel execution/approval ports and checks Agent control
helpers before dispatch. Complete native inventory remains a separate gate.

## Remaining Gates

Complete trusted native ownership/inventory, all-tool admission and direct async
work tracking, installed lease/report/release integration, main-death active-model
recovery, legacy/lifetime retention, Windows ACL/cwd/Job, business runtime/log/health,
UI/manual and signed-package acceptance remain open. No production service start,
stop, implicit stale-lock repair or automatic recovery is enabled. Issue #7 and
its native dependency #5 remain open; incomplete acceptance stays unchecked.
