# SDK Shutdown And Ordered Host Exit Preparation

Follow-up to #7's [profile boundary](../protected-application-profile/README.md)
and [asynchronous checkpoint experiment](../service-execution-async/README.md).
This slice fixes production SDK shutdown receipts and tests a separate Host exit
ordering contract. It does **not** install the experimental service controller,
report persistence transport, or recovery lease into production `task/quit`.
Production service execution stays unavailable; #7/#10/#47/#24 remain open.

## Production Changes

`SdkContextClient.dispose()` seals new requests synchronously and caches one
promise, including failure. Calls already awaiting bootstrap recheck the seal
before dispatch. Graceful dispose needs the exact `{ disposed: true }` payload.
Graceful shutdown and native Worker termination each have a default 15-second
receipt deadline. Protocol poisoning and explicit dispose share the same native
termination promise. Termination failures, malformed receipts or timeouts stay
`sdk-context-shutdown-unconfirmed`; later calls and
late replies never convert that failed receipt into success. Cleanup still
attempts native termination after graceful failure. A termination receipt is the
Node Worker API's promise result, not a service/process-tree ownership receipt.

`TaskWorkspaceHost.shutdownSdk()` caches its success or failure rather than
clearing references and letting a second call pretend nothing was running.
Provider installation is single-in-flight and forbidden after sealing. A late
open is disposed rather than attached. Failed previous-context disposal fences
further configuration and remains part of shutdown failure. An unavailable
bootstrap remains unknown even if it completes and gets cleaned up later.

Task Host receipt budgets: bootstrap/configuration 30s, isolated context 35s,
read-only kernel 15s. Production `task/quit` also bounds turn settlement at 15s
and caches the **legacy** lifecycle quit result/failure. These receipt stages
have nominal headroom within main's existing 120s per-task RPC timeout; scheduler
stalls and synchronous callbacks are not bounded by JavaScript timers. A timeout
does not cancel arbitrary injected work or prove termination.

Main `quitAll()` refuses release whenever any returned failure exists, even if
`retainedTasks` is empty. This fixes an inconsistent report being interpreted as
safe by the previous aggregate predicate. No main writer/lease is disposed by
this change. `disposeAll()` itself is still an unconditional resource disposal
method and is not an ownership or durable-ack validator.

## Separate Exit Ordering Experiment

`ExperimentalHostShutdown` consumes trusted producer callbacks, not RPC payloads:

1. Seal SDK dispatch and every supplied experimental service synchronously.
2. Await SDK shutdown, then turn settlement.
3. Close supplied services; require `ok: true` and `stopped`/`exited`.
4. Revalidate the lease/config callback, await a durable report acknowledgement,
   and revalidate again before returning a closed receipt.

Service cleanup is attempted even after an SDK failure, but such a run cannot
persist a closed report. Every stage is bounded; pending/invalid/failed receipts
cache an unknown result. There is no retry or late-ack repair. Report fields are
only `schemaVersion/taskId/hostEpoch/status`, with no paths, commands, credentials
or process IDs. A frozen report cannot be mutated by its persistence callback.

`ExperimentalServiceExecution.seal()` now closes dispatch without beginning
service drain. Its existing `close()` calls seal and retains the same durable
terminal/ownership semantics. The real controller is used in an ordering test:
SDK completion precedes stop, terminal checkpoint acknowledgement precedes
ownership release/report persistence, and report acknowledgement precedes a
successful Host receipt.

**The report sink is an injected unit-test port. No actual main journal/parent
report transport or main disposal consumer is wired to this experiment.** Those
are still the next integration barrier. An installed implementation must supply
all catalog/owned services, validate current sender/task/epoch before accepting a
report, seal all executable tools, and maintain leases until trusted ownership
and durable report confirmation. This experiment has per-stage deadlines, not a
constant total deadline independent of the number of services.

## Verification

Final full gate:

```sh
pnpm turbo run typecheck test build lint --force
```

Log: `/tmp/pidock-gate-shutdown-final2.log`.

- 8/8 tasks successful.
- Shell: 86 files; 1121 passed, 1 existing Windows-only skip.
- Renderer: 77 files; 609 passed.
- 27 added cases: 7 context client, 5 task SDK lifecycle, 14 exit ordering,
  and 1 main inconsistent-report refusal.
- Optional test-inclusive `tsc` still has the same 72 pre-existing diagnostics,
  normalized line/column comparison adds/removes none. This optional check is
  not green. Log: `/tmp/pidock-shutdown-test-types-final2.log`.

Actual Worker fault probes:

```sh
node packages/shell/scripts/sdk-shutdown-test.mjs
node packages/shell/scripts/sdk-context-isolation-test.mjs
```

Logs: `/tmp/pidock-sdk-shutdown-worker-final.log` and
`/tmp/pidock-sdk-shutdown-isolation-final.log`.

Three actual Node worker-thread transport cases: clean disposal, a worker silent
on dispose, and a deliberately withheld termination promise after actual native
exit. Every case seals requests and terminates once; the last two retain failure
on repeated dispose even though test observation sees the thread gone. These
transport fault workers are **not** the SDK or native service supervisor. The
separate existing isolation test uses the real SDK worker and loopback model
endpoint, confirms no tools, no ambient credentials, redacted stream/JSONL, and
successful worker disposal/refusal afterwards.

Actual Electron:

```sh
pnpm --filter @pidock/shell exec electron scripts/electron-issue46-provider-test.mjs
pnpm --filter @pidock/shell exec electron scripts/electron-sdk-bridge-test.mjs
pnpm --filter @pidock/shell smoke:async-checkpoint
```

Logs: `/tmp/pidock-sdk-shutdown-electron-final3.log`,
`/tmp/pidock-sdk-shutdown-bridge-regression.log`, and
`/tmp/pidock-shutdown-async-regression-final.log`.

- Electron 44.4.3 / Node 24.21.0: real production renderer/main/task utility/SDK
  worker/loopback Provider. Model reply arrives, SDK history remains redacted,
  two UI-attested quit calls return the identical lifecycle receipt, and a
  subsequent trusted **main** Provider install is rejected as `sdk-host-closing`.
  This tests shutdown after a completed model turn, not every active-model
  cancellation/disconnection race or installed service shutdown.
- Existing bridge covers streamed result/cancel/reopen and post-quit refusal.
- Existing four actual native async-checkpoint scenarios pass unchanged.
- No renderer implementation changed; the Provider script's existing 1440px
  screenshot is diagnostic only, not a new two-size UI acceptance claim.

## Failure History

- `/tmp/pidock-shutdown-test-types.log` initially added two Promise<unknown>
  fixture diagnostics. Explicit open-result types fixed them; no baseline errors
  were modified.
- `/tmp/pidock-sdk-shutdown-electron-first.log`: old test expected an unassigned
  task row's `进入工作区` button instead of current task sidebar navigation.
  Updated the script to current sidebar/model-picker/Provider form controls.
- `/tmp/pidock-sdk-shutdown-electron-fixed.log`: subscription was legitimately
  revoked as `sdk-sender-navigated` during navigation. The script now waits for
  initial connection and uses the existing explicit reconnect action if that
  specific navigation failure occurs. Production subscription checks unchanged.
  This invocation also overlapped a build; final verification ran only after
  build completion.
- `/tmp/pidock-sdk-shutdown-electron-final.log` and
  `/tmp/pidock-sdk-shutdown-electron-report.log`: new assertion read the wrong
  layer of renderer's `payload.payload` envelope. The actual quit already had
  zero failures/retained tasks; fixed the assertion, not the report predicate.
- `/tmp/pidock-sdk-shutdown-electron-final2.log`: attempted Provider installation
  through renderer's generic task API, which intentionally forbids that
  main-only operation. The final test uses the existing trusted main route.
  No preload/renderer allowlist was expanded.
- Some historical Electron runs returned process exit code 0 despite logging
  `ISSUE46_E2E_FAILED`. Verification requires the final
  `ISSUE46_SDK_SHUTDOWN=` marker as well as command completion; exit code alone
  was not counted as passing evidence.

## Remaining Gates

Formal main-owned durable report storage and its bounded actual parent transport,
bootstrap cancellation/lease revocation, parent disconnect/main death, all-tool
sealing, known service inventory, and release only after trusted current-Host
confirmation remain unimplemented. The legacy lifecycle record is not the new
service recovery journal or a durable report acceptance proof. Unknown service
checkpoints and save failure retain ownership as before. A failed cached shutdown
needs a separately authorized repair/new Host policy, not automatic success on
retry. Real active-model fault coverage, Windows ACL/cwd/Job testing, stale main
writer-lock repair/presence markers, installed artifact discovery/signature and
atomic execution, business configuration and health/log UI remain open. No
Windows machine results or OS sandbox claims are added.
