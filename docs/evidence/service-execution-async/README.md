# Asynchronous Durable Checkpoint Experiment

Follow-up to [main-owned leases](../service-recovery-leases/README.md) and
[service lifecycle](../service-execution-lifecycle/README.md). Production Host entry,
`task/controlService`, and `task/quit` remain unchanged and unavailable for service
execution. This is a development experiment, not business or installation acceptance.

Later [profile-boundary follow-up](../protected-application-profile/README.md) adds
trusted main/Host path checks for task sources and guarded file APIs. It does not
provide a filesystem sandbox or enable this experiment in production.

## Contract

`ServiceExecutionRecoveryPort.write` now accepts a synchronous durable return or
`Promise<undefined>`. A send/queued receipt is not a durable acknowledgement.
`ExperimentalServiceExecution.create()` awaits a trusted asynchronous read, validates
it, and rechecks the trusted revision/lease callback before exposing a controller.
It does not expose a temporary default stopped controller. Invalid, rejected or
revoked bootstrap fails; interrupted states still restore as unconfirmed without
replay, launch, PID adoption or inferred termination.

Checkpoint saves are serialized for a single service generation. Starting is
acknowledged before executor invocation; running is acknowledged before delivering
start success; stopped/exited is acknowledged before relinquishing durable resource
ownership or reporting safe close. Completion and stop receipts share one terminal
save per generation. A terminal already observed cannot be overwritten by a queued
running/stopping save or cancellation rollback. Old-generation completions are
ignored. While natural terminal persistence is pending, verificationRequired fences
new task writes, including the old owner. Control requests also reject pending saves.

Operation claims remain held through saves, launch, cleanup and final ack. Cancellation,
closing, caller/session identity, permission and trusted config/lease revision are
rechecked after yielding before start/stop dispatch. If starting was saved but the
executor was never called, a stopped/null-owner record can be saved as a zero-resource
proof. If stop authorization changes during stopping save, no stop is dispatched;
the still-owned running record is restored only when no terminal already supersedes it.
Trusted lifecycle close can subsequently drain its own actual session without becoming
an external approval bypass.

Any checkpoint persistence failure fences all further saves in that controller, retains
unconfirmed ownership and prevents a safe close report. A live owned session may still
be cleaned up, but even a clean native stop cannot repair a possibly written checkpoint
by blindly retrying through the failed storage port. This tightens the previous
synchronous experiment's cleanup behavior. No state reset or automatic repair is added.

`experimentalCheckpointClient()` is an internal dedicated-parent-transport client:
strict task/service/epoch scope, monotonically increasing request IDs, one outstanding
request, exact bounded acknowledgements, and validated checkpoint payloads. Only an
explicit null read checkpoint means no record. Write acks must have no checkpoint or
extra fields. Timeout, disconnect, malformed/foreign/duplicate/error ack, or a possibly
sent transport failure fences the client, rejects the pending request and prevents
retries. Late acks do not recover it. Deadlines are configurable from 10 ms to 30 s,
with a 5 s experiment default. The caller must use a trusted transport and identity;
this module is not authentication against arbitrary same-UID code.

## Automated Evidence

New tests: **13 asynchronous lifecycle tests** and **7 transport tests**. They cover
blocked starting/running acks, write failures, cancellation/close/permission/config
changes, terminal serialization, natural terminal verification fence, failure after
actual session delivery, stop rollback, completion/stop deduplication, late generations,
async bootstrap and malformed/timeout/disconnected/duplicate acknowledgements.

Existing **33 lifecycle/authorization tests** were retained. Timing assertions now
wait for the actual executor/stop or terminal state rather than assuming one microtask
means a durable operation finished. Cleanup-persistence-failure assertions now demand
unconfirmed state and no later journal retry, even when native cleanup succeeds.

Final `pnpm turbo run typecheck test build lint --force`: **8/8**, zero cached;
shell **1080 passed, 1 Windows-only skipped**, renderer **609 passed**.
Log: `/tmp/pidock-gate-async-checkpoint-final2.log`.

The optional test-inclusive `tsc -p tsconfig.json --noEmit` remains non-green with the
same **72 baseline diagnostics** (comparison normalizes changed source line numbers).
New test type errors found during verification were fixed with explicit fixture types;
no new diagnostics remain and no unrelated baseline tests were edited.
Log: `/tmp/pidock-async-test-types-final.log`; baseline recorded in the lease evidence.

## Actual Electron/Main/Native Chain

After shell build and development mac supervisor build:
`pnpm --filter @pidock/shell smoke:async-checkpoint`.

Isolated main creates real TaskRootIndex/ProjectRegistry/catalog and the private
main-owned journal, prepares a development supervisor request from trusted catalog,
and binds its lease to the actual utilityProcess instance. The test-only utility uses
the new async parent-port client and lifecycle factory. Checkpoint replies originate
only after main lease/storage returns. Neither profile/journal path nor secrets are
part of the checkpoint transport. The test fixture retains its older filesystem
adapter for the old smoke only; the new epoch branch uses main-owned storage instead.

Four scenes passed on macOS arm64, Electron **44.4.3**, Node **24.21.0**:

- **close**: actual service/descendant starts, main running checkpoint ack precedes
  delivered success. Native stop and main terminal publication occur, but a test
  barrier holds the stopped ack; the utility cannot report close until it is released.
- **cancel**: actual native ready is held at the test delivery barrier, cancel cleans
  the owned session and awaits stopped persistence. Control does not report start
  success; trusted close succeeds only after durable terminal state.
- **recovery**: actual Host SIGKILL after running publication; a fresh utility obtains
  a fresh lease and asynchronously reads running as unconfirmed. Zero launch attempt,
  start/safe-close refusal and verification gate remain even when the test observes
  previous native resources gone. Old captured lease writes are refused.
- **lost-start-ack**: main publishes starting, deliberately withholds its ack. No native
  started event occurs; the client times out/fences, control reports persistence failure,
  and a late ack cannot repair it. Main retains starting. Fresh utility asynchronously
  restores unconfirmed with zero launch attempts, never treating timeout as absence.

The probe verifies this run's observed service/helper/descendant disappearance where
resources were launched; PID checks and emergency kills are test cleanup, not production
ownership/recovery authority. Replies, utility stdout/stderr, checkpoint requests and
journal exclude the synthetic private value. Prepared launch payloads still contain
values on the trusted test parent transport; they are not renderer projections.

Final log: `/tmp/pidock-async-checkpoint-utility-final2.log`.
Existing nine-scene native supervisor smoke and two-Host lease probe also passed again:
`/tmp/pidock-async-checkpoint-supervisor-final2.log` and
`/tmp/pidock-async-checkpoint-leases-regression.log`.

## Retained Failures

- First transform/typecheck failed on a duplicate local `denied` declaration; fixed
  with distinct post-start/post-stop guard locals. No runtime success criteria changed.
  Logs: `/tmp/pidock-async-lifecycle-first.log`, `/tmp/pidock-async-lifecycle-second.log`.
- New test initially attempted to assign the channel's read-only permission getter;
  corrected to actual `PiSessionChannel.setPermission()`. Log:
  `/tmp/pidock-async-checkpoint-tests.log`.
- First full gate stopped at two empty test cleanup catch blocks rejected by lint,
  cascading cancellation to other turbo tasks. Comments now identify test-only PID
  cleanup; subsequent complete gates passed. Log:
  `/tmp/pidock-gate-async-checkpoint-first.log`.
- First new Electron probe passed close then failed cancel bootstrap: its optional
  test ack barrier compared undefined state to undefined heldState and accidentally
  withheld the read ack. Fixed to require an explicitly selected held state. Deadlines,
  factory/client validation and lifecycle success checks were not relaxed. First
  failure: `/tmp/pidock-async-checkpoint-utility-first.log`; corrected and final runs
  are separately retained.

## Remaining Gates

No production RPC wiring, SDK cancellation mapping, or SDK shutdown -> service drain
-> durable report -> main disposal integration is enabled. The script parent router
is test-only, not an installed Host startup/transport implementation. Main execution
capability/config authentication, coordinated lease revocation, bootstrap cancellation
and reporting, and full multi-service recovery require explicit production contracts.
An injected arbitrary recovery Promise can still stall forever; the new experiment
client is bounded, but injection alone does not prove every caller has a bounded port.

Application profile/aliases must be excluded by trusted task-tool/source authorization.
POSIX private modes do not protect against same-UID arbitrary shell/service tampering.
Stale main writer-lock repair, Windows ACL/cwd/Job actual tests, signed/installed
supervisor discovery and atomic executable identity remain blockers. No new Windows
runtime acceptance, renderer changes, UI screenshots or business service acceptance.
The untracked research document is untouched. #7/#10/#47/#24 remain OPEN.
