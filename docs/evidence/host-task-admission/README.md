# Installed Host Task RPC Admission Seal

Follow-up to [active model report faults](../active-model-report-faults/README.md)
for [issue #7](https://github.com/Leonz3n/PiDock/issues/7). This is an installed
Host task-RPC shutdown barrier, not complete tool/resource inventory or service
execution enablement.

## Contract And Compatibility

Previously `task/quit` only sealed SDK admission. Other task operations could
still enter the same Host while it was quitting, including draft/permission
writes, approvals, terminal/browser operations and schedule evaluation. The
installed Host now routes every non-quit task operation through one
`HostTaskAdmission`. A legal, caller-validated quit synchronously seals that
admission before SDK shutdown. Invalid/Agent-session quit does not seal it.

All subsequent task operations are refused with `task-host-closing`; SDK paths
keep the existing `sdk-host-closing` error. This deliberately includes apparent
reads: some projections open sessions or reconcile state, so shutdown does not
maintain a permissive read allowlist. Repeated `task/quit` stays outside the
admission gate, still validates the caller and shares the cached quit receipt.
Host ping/version diagnostics remain available. A fresh actual Host gets fresh
admission; this does not unseal a closing instance.

Accepted task operations are registered before invoking work and remain tracked
until their promises settle, including rejected operations. After SDK/turn
settlement, quit waits for the sealed task-operation set within the existing
15-second deadline style, before lifecycle quit observes/cancels its resources.
An operation refusal is settlement, not proof of side-effect success. Timeout
keeps the existing failed cached quit receipt; it does not cancel arbitrary
underlying work, release its resources or authorize process termination.

The real probe also exposed a browser adapter bug: utility parent-port message
listeners receive `{ data }`, whereas `HostBrowserClient` consumes bare protocol
messages. Host now unwraps the event at that trusted adapter, allowing main's
browser response to settle the admitted task operation. The client remains
bound to the task/workspace parent transport. No browser capability or caller
permission is widened.

This gate covers the installed task RPC dispatch surface, not direct
`TaskWorkspaceHost` calls, SDK model tools, detached child/Agent work, scheduled
runs outside dispatch, native process inventory or a main admission barrier.
Already-admitted work may finish its existing effects after seal; it is waited
for, not retroactively revoked. This is not all-tool sealing or complete owned
resource proof, and no production service/report/recovery execution is enabled.

## Verification

```sh
pnpm turbo run typecheck test build lint --force
pnpm --filter @pidock/shell smoke:task-admission
pnpm --filter @pidock/shell smoke:active-turn-quit
pnpm --filter @pidock/shell smoke:active-model-report
```

Full final gate `/tmp/pidock-admission-gate-final.log`: 8/8; shell 91 files,
1177 passed / 1 existing Windows-only skip; renderer 77 files, 609 passed.
Three new admission tests cover synchronous seal, every accepted operation's
settlement (including rejection), refused late callback zero execution,
requirement to seal before snapshot and reentrant/synchronous failure cleanup.
Initial missing-module red `/tmp/pidock-admission-red.log`; focused green
`/tmp/pidock-admission-focused.log`.

Actual macOS arm64 Electron 44.4.3 / Node 24.21.0 probe uses compiled production
`host-entry.js` utility and actual HostClient/task RPC with a test main shell
attestation, no renderer. It starts one human browser request but deliberately
holds the **test main response**, without acting on a real page. After legal
quit starts it verifies refusal of draft writing, permission changing, approval,
new browser action, schedule evaluation, file roots and session states, plus
existing SDK refusal. Exactly one browser callback is observed. After 50ms the
quit receipt is still pending. Returning main's explicit browser refusal ends
the original operation and permits lifecycle quit with no retained/failure items
for this fixture. Repeated quit returns the same receipt. A forbidden Agent quit
beforehand does not prevent ordinary admission. Persisted original draft remains,
late draft is absent. Native kill afterward is fixture cleanup, not cooperative
resource-tree exit evidence. Log `/tmp/pidock-admission-electron-final.log`,
`TASK_ADMISSION_OK`.

Failure history is explicit: the first probe had Electron startup blocked by
top-level await (`/tmp/pidock-admission-electron-red.log`, `red2.log`); a later
probe used an invalid browser action (`red3.log`). These are harness errors, not
product regression reproductions. After correction, the preceding compiled Host
accepted a late draft: `/tmp/pidock-admission-electron-red4.log`, missing expected
rejection. The first built gate then passed admission but timed out the existing
browser request because its adapter ignored wrapped replies:
`/tmp/pidock-admission-electron-green.log` (despite its tentative filename).
After adapter correction, a fixture assertion incorrectly expected draft text
in `sessionStates`, which does not expose it (`green2.log`); that assertion was
removed and the actual persisted-draft assertion retained. Final probe passed.

Regressions: `/tmp/pidock-admission-quit-regression.log` (three real installed
SDK/loopback active quit scenes) and `/tmp/pidock-admission-report-regression.log`
(six real experimental SDK/native service/report/release fault scenes), passed.
Optional test-inclusive tsc remains red with the same 72 baseline diagnostics,
byte-identical to `/tmp/pidock-active-report-test-types.log`; latest log
`/tmp/pidock-admission-test-types-final.log`. It is not reported as passing.

## Follow-Up

[Direct Host execution seal and derived retention](../direct-host-execution-seal/README.md)
adds guards below dispatch and retains metadata on uncertain disposal. It does
not establish complete native owned-resource inventory.

## Remaining Gates

All-tool/direct-call sealing, complete actual owned-resource inventory and
installed combined lease/report/release adapters remain missing. Browser reply
settlement here is transport evidence, not real page/CDP shutdown or rendering
acceptance. Signed installed artifacts, active-model main SIGKILL/credible recovery,
trusted stale-lock repair, migration/retention, Windows ACL/cwd/Job, business
environment/log/health and UI/manual acceptance remain unfinished.

Independent subagent review is still unavailable due to the previously recorded
host/core `./node` export incompatibility; no alternate CLI or independent
approval is claimed. #7/#10/#47/#24 remain open, incomplete boxes unchecked.
The original untracked research document is untouched and unstaged.
