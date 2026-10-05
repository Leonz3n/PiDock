# Actual Main Death And Fail-Closed Restart

Follow-up to [durable shutdown reports](../host-shutdown-reports/README.md).
This slice adds actual Electron main SIGKILL/restart evidence. It changes only
explicit test scripts and evidence, not production recovery or lock repair.
Production service control and installed report integration remain unavailable.

Follow-up: [presence witnesses](../recovery-presence-witnesses/README.md) now
refuse loss of the recovery directory or both task journal copies when the
sibling witness survives. Its main-death regression also snapshots that witness.
Complete profile/witness deletion, coordinated rollback and trusted stale-lock
repair remain unimplemented; the observations below are the original slice.

## Observed Contract

A surviving Node test harness starts an actual separate Electron main, which
uses real TaskRootIndex/ProjectRegistry/catalog/private recovery store and an
actual utility Host. The utility launches the development native supervisor and
Go process-tree fixture. The original random-token `writer.lock` is exclusively
owned by main; it contains no PID or proof that its former writer/resources are
gone. Two kill barriers are tested:

- `running`: current main has acknowledged a durable running checkpoint. No
  shutdown report exists. The observed native fixture descendant must have
  announced itself before the kill barrier is usable.
- `held-report`: a real zero-tool SDK worker was opened and shut down, the real
  service controller drained with terminal checkpoint acknowledgement, and main
  published the closed report. Report acknowledgement is withheld; neither Host
  completion nor main release confirmation has occurred when main is killed.

Before SIGKILL, another actual Electron main tries to open the same store and
is refused. The original main is still running. After the external test harness
SIGKILLs the actual main PID and observes its child-process exit signal, a fresh
actual Electron main reloads the same catalog and tries to construct the store.
It is refused as `service-recovery-unavailable` before creating any utility Host.
There is no lock stealing, PID-based repair, old epoch reuse, service replay,
report adoption, backup fallback or implicit stopped state.

Before/after live contention and restart snapshots compare lock, primary and
backup content, device/inode, permission bits, size, mtime and ctime. They are
unchanged. This checks these three files only, not an assertion that Electron
never updates any other profile data. Original journal in `running` remains
running/owned; the held-report journal remains stopped/unowned plus the same old
report. Neither journal is converted into a new execution/release authority.
No successful writer/lease/controller is exposed on restart.

## Verification

```sh
pnpm turbo run typecheck test build lint --force
pnpm --filter @pidock/shell smoke:main-death
pnpm --filter @pidock/shell smoke:shutdown-report
```

- Final full gate: `/tmp/pidock-main-death-gate-final2.log`, 8/8 successful;
  shell 87 files, 1136 passed / 1 existing Windows-only skip; renderer 77 files,
  609 passed. No new unit test count is claimed for these process probes.
- Actual main-death probe: `/tmp/pidock-main-death-final2.log`, both scenarios
  passed, Electron 44.4.3 / Node 24.21.0 on macOS arm64. Successful marker required
  in addition to command completion.
- Four report scenarios regression: `/tmp/pidock-main-death-report-regression.log`.
- Optional test-inclusive typecheck: `/tmp/pidock-main-death-test-types.log`, the
  same 72 baseline diagnostics, normalized line/column comparison adds/removes
  none. This optional check remains red, not an acceptance gate success.
- Synthetic native environment and SDK credential are absent from captured main
  output, writer token, primary and backup. Test home path is absent from those
  three stored bodies. Test barrier PID metadata is not a production journal or
  a renderer projection.

500ms after refused restart, `kill(pid, 0)` observations found no old utility Host
in either scenario. In `running`, one of the three native fixture PIDs still
existed; in `held-report`, none did. This is **PID existence**, not identity,
running/idle/zombie classification, tree termination confirmation or authorization.
It cannot be interpreted as all resources safely stopped because main died. The
harness uses its exact observed fixture PIDs for test-only emergency cleanup and
waits until no observed PID exists before deleting its isolated temporary home.
It does not offer this cleanup or any test PID to the restarted recovery store.

The fixture reports PIDs after actual boot/native events, before the barrier,
so failed initialization can also clean up this run's observed processes. No
production main/Host code, renderer implementation, screenshot acceptance,
Windows execution or installed discovery changed in this slice.

## Failure History

- `/tmp/pidock-main-death-first.log`: barrier timeout on the second scenario.
- `/tmp/pidock-main-death-debug.log`, `debug2.log`, `debug3.log`: bounded main-stage
  evidence located the failure. Closing immediately after control success could
  stop the fixture before its descendant log arrived. The expected three native
  observations therefore never completed. Corrected the sequence to wait for
  actual descendant observation before requesting close; no timeout was extended
  and no expected descendant was removed. Message handler errors now emit an
  explicit failed event/exit instead of leaving a silently unusable main alive.
- `/tmp/pidock-main-death-fixed.log`: both main-death scenarios passed after that
  fix. Output observations were subsequently split into Host versus native PID
  existence, without claiming executable activity from `kill(pid, 0)`.
- `/tmp/pidock-main-death-final.log`: stricter failure-cleanup PID validation
  rejected `child.pid` observed immediately after `utilityProcess.fork`, before
  native startup populated it. Moved this observation to the actual boot event,
  kept strict PID validation, and reran successfully in `final2.log`.
- Post-run process inspection found no remaining Electron/helper/native entries
  for this fixture. Earlier failed probes are not counted as successful evidence.

## Trusted Repair Gate Still Unimplemented

Restart is deliberately unavailable, not a completed automatic crash-recovery
feature. A persisted closed report proves publication of a previous Host claim,
not delivery/consumption of its ack, survival of main confirmation or absence of
all owned resources. The random lock token and old PID absence do not prove the
exclusive writer is gone under a trustworthy process identity contract.

A future repair design must establish an authenticated exclusive recovery
context, preserve the old profile/task/journal identities and unknown-resource
state, define main/Host/supervisor termination verification and a durable repair
record, and handle partial repair publication without blind retry. Operator
consent alone does not provide OS exclusivity or tree ownership. This slice
introduces no repair API, no automatic unlink, and no "reset to empty" option.

Still blocked: abnormal writer-lock repair, durable initialization/presence
markers for whole-directory or primary+backup deletion, installed startup/report
transport/lease disposal handshake, all-tool sealing and complete service
inventory, active-model fault cases, Windows ACL/cwd/Job evidence, signed artifact
discovery/atomic execution and business environment/log/health/manual acceptance.
The entire-directory deletion case and same-UID filesystem modification remain
outside the protection proven here. #7/#10/#47/#24 stay OPEN, incomplete boxes
untouched; the unrelated untracked research document remains untouched.
