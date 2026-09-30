# macOS Anchor SIGKILL Delivery Race

## Diagnosis

The existing bridge tests sometimes received native `termination-unconfirmed`
on parent exit or control disconnect. Green repeats did not explain the cause.
The production executor remained closed throughout this investigation.

A single-build native loop alternates service-parent exit code 3 and control
input disconnect. Each service spawns one known descendant. The loop checks the
actual terminal record and descendant disappearance, with at most eight active
scenarios. `PIDOCK_TEST_SUPERVISOR_BINARY` selects a trusted test binary only;
it is not read by the supervisor or any production entry.

Running the old development binary reproduced the exact symptom. A test-only
kqueue observer, registered against the service's process-group anchor, caught:

```text
terminal={Event:error PID:0 Code:0}
diagnostic=service-supervisor: termination-unconfirmed
observed=anchor-wait-status-512
```

Wait status 512 means ordinary exit code 2, not SIGKILL. After requesting group
SIGKILL, `runAnchor` used to immediately call `os.Exit(2)`. macOS group signal
delivery can lag the successful syscall; an ordinary exit can race actual death
and cause `anchorStopped` to correctly reject the ownership confirmation.
Earlier sequential/concurrent loops and a diagnostic rebuild did not reproduce;
the old-binary differential and kqueue observation narrowed the failure.

A child-process regression injects delayed SIGKILL dispatch at that exact call
site while retaining the real anchor entry, private stdin and readiness fd. It
schedules actual SIGKILL 20ms after returning success. Before the fix:

```text
go -C packages/shell/native/service-supervisor test -run '^TestAnchorDelayedKill$' -count=1 ./...
--- FAIL: TestAnchorDelayedKill
    delayed SIGKILL lost to anchor exit: exit status 2
```

## Fix

After successful SIGKILL dispatch, the anchor now parks until actual signal
death instead of racing it with an ordinary exit. A failed dispatch still exits
2 and never confirms termination. Supervisor Stop retains its bounded wait and
fallback group kill; only observed SIGKILL death is accepted. Safe fixed reason
codes identify anchor exit/signal, wait failure or timeout without printing
request data, private environment or arbitrary OS error messages. No bridge
success condition was relaxed and no production RPC was connected.

`runAnchorWithSignal` is an internal test boundary; the production entry always
passes `syscall.Kill`. The test's delayed/failed modes exist only in the Go test
executable, not the supervisor's CLI/environment protocol.

## Verification

```sh
go -C packages/shell/native/service-supervisor test -run '^TestAnchorDelayedKill$' -count=20 ./...
go -C packages/shell/native/service-supervisor test -run TestRepeatedLifecycle -count=30 -failfast ./...
go -C packages/shell/native/service-supervisor test -race -count=1 ./...
go -C packages/shell/native/service-supervisor vet ./...
pnpm --filter @pidock/shell build:supervisor:mac
PIDOCK_TEST_SUPERVISOR_BINARY="$PWD/packages/shell/build/service-supervisor/darwin-arm64/service-supervisor" \
  go -C packages/shell/native/service-supervisor test -run TestRepeatedLifecycle -count=80 -failfast ./...
pnpm turbo run typecheck test build lint --force
pnpm --filter @pidock/shell smoke:supervisor
```

- Delayed dispatch and failed-dispatch cases passed 20 repetitions; failed
  dispatch retains exit 2 and is not considered `anchorStopped`.
- 3600 real lifecycles passed using fresh ordinary builds.
- 9600 real lifecycles passed using the rebuilt development artifact, including
  concurrent full-gate load. This reduces recurrence risk, not a universal
  timing guarantee.
- macOS Go race tests and vet passed.
- Complete product gate: 8/8; shell 1020 passed / 1 Windows-only skipped,
  renderer 609 passed.
- Actual Electron 44.4.3 / Node 24.21.0 utilityProcess six scenarios passed:
  stop and disconnect confirmed stopped; Host exit/SIGKILL yielded no receipt;
  supervisor SIGKILL stayed unconfirmed; service-parent exit preserved code 3.
  This run's observed helper/service/descendant resources were gone and utility
  processes exited. Synthetic private values remained absent from outputs.
- Windows build, test compilation and vet passed; no Windows execution or
  acceptance is claimed. Windows binary hash is unchanged.

Development artifact hashes (unsigned, not installation evidence):

```text
macOS binary: e33cb5de4ac5f7691e2742628bd339bada6150250efc7cbf31b29b67633069d3
Windows binary: daab52957927568e9a808d747a275a70518604cf613a6d9f4523e127738445a4
source tree: 759f7130b2b0f95ba00e1f06404b8f83eefbf5220108426e17ea000660057a68
Go: go1.27.1 darwin/arm64
```

## Remaining Boundaries

No production enablement, signing/install discovery, atomic executable
verification, Windows cwd identity/Job runtime acceptance, real business
configuration or health UI is added. Deliberately detached descendants remain
outside the macOS group contract. The kqueue observer and emergency test PID
cleanup are diagnostic evidence, not production ownership authority. Unknown
termination still blocks unsafe restart. Issues #7/#10/#47/#24 remain open.
