# Retained Legacy Channel Admission Seal

Follow-up to [direct Host execution seal](../direct-host-execution-seal/README.md)
for [issue #7](https://github.com/Leonz3n/PiDock/issues/7). This closes retained
legacy Agent channel entry points; it is not complete native inventory or
production service enablement.

## Contract

`TaskWorkspaceHost.sealExecution()` now seals every existing PiSessionChannel.
Channels materialized or restored for metadata reads in that closing Host are
sealed before being returned too. Retained objects and bound methods cannot
start another scripted turn/compaction, mint approval, approve a pending request
or spend an approved authorization. Turn/compaction/approval refuse with
`task-host-closing`; gate previews return deny with that reason; consume returns
false without mutating its receipt. Seal is in-memory, irreversible per instance
and not persisted as a new session fact. A fresh Host remains independently
admissible, not implicitly authorized to repair locks or recover services.

Agent browser, modeled service and terminal control helpers read this admission
refusal through the existing gate contract before write claims and again before
execution. They also check after acquiring the claim and after synchronous
approval persistence, so a reentrant seal cannot issue the next action. Existing
read/default/auto permission mappings and scope-bound one-shot approval policies
are unchanged. A consumed approval is not restored if persistence subsequently
seals the channel; the action is refused and the claim settles.

ExperimentalServiceExecution separately checks the channel seal before claims
and across its awaited persistence/checkpoint guards. Its own shutdown admission,
trusted supervisor cleanup and native uncertainty rules remain separate; this
adds no installed service RPC wiring. Already-dispatched work is not retroactively
revoked by the legacy channel seal. An existing browser request can still log its
result, persist and release its original claim. Snapshot/read, rejection, cancel,
message append and usage settlement remain available for cleanup/history.

## Verification

```sh
pnpm --filter @pidock/shell exec vitest run src/host/legacy-channel-seal.test.ts src/host/browser-control.test.ts src/host/service-control.test.ts src/host/terminal-control.test.ts src/host/service-execution-experiment.test.ts src/main/pi-session.test.ts src/host/task-execution-seal.test.ts
pnpm turbo run typecheck test build lint --force
pnpm --filter @pidock/shell smoke:direct-execution-seal
pnpm --filter @pidock/shell smoke:task-admission
pnpm --filter @pidock/shell smoke:active-turn-quit
pnpm --filter @pidock/shell smoke:active-model-report
```

13 added tests: four retained/bound/future/restored channel tests; six auto-tier
and persistence-reentrant control refusals; one already-dispatched browser
settlement; two experimental pre-dispatch/persistence guards. The focused suite
passes 102/102. Full gate passes 8/8: shell 93 files, 1198 passed / 1 existing
Windows-only skip; renderer 77 files, 609 passed. Logs
`/tmp/pidock-legacy-seal-focused-first.log` and
`/tmp/pidock-legacy-seal-gate-final.log`.

Failure evidence: `/tmp/pidock-legacy-seal-red.log` reproduces retained-channel
admission before the channel seal implementation. Six new control refusal tests
reproduce actual auto/persistence bypasses in
`/tmp/pidock-legacy-seal-adapters-red.log`; a seventh failure there was an existing
fixture assumption of process-global approval-1 after new tests minted IDs. The
service test now resets sequences per case. Two experimental guard reproductions
are in `/tmp/pidock-legacy-seal-experiment-red.log` (injected supervisor/persistence,
not actual native process failures).

The extended direct-call Electron probe genuinely failed against the prior
compiled build: `/tmp/pidock-legacy-seal-electron-red.log`, missing expected
retained-channel exception. Its late callback wrote a private test marker before
failure; cleanup was not a graceful receipt. After rebuilding, real macOS arm64
Electron 44.4.3 / Node 24.21.0 SDK Worker/AgentSession/loopback SSE probe passes:
`/tmp/pidock-legacy-seal-electron-final.log`. Retained legacy turn and an auto Agent
browser helper with a deliberately independent open write coordinator refuse;
late action callback count is zero and marker absent. The browser gateway is a
write-marker-backed TEST callback, not real page/CDP evidence. The SDK still has
zero tools, one Provider request, model cancellation, HTTP close and observed
native Worker exit; credential excluded; unknown derived witness is metadata only.

Installed RPC admission, three actual active-turn quit scenes and six actual
experimental active-model/report fault scenes pass again:
`/tmp/pidock-legacy-seal-{admission,quit,report}-regression-final.log`.
Optional test-inclusive tsc remains failing with 72 baseline diagnostics,
unchanged after normalizing source line shifts, in
`/tmp/pidock-legacy-seal-test-types-final.log`. No independent subagent approval
is claimed; the earlier failed review infrastructure run has not been retried.

## Remaining Gates

This seals the actual returned legacy channels and these Agent control helpers,
not arbitrary structural ports, raw gateways/runtime APIs, human helper calls
outside installed RPC admission, asynchronous work hidden in unsupported scripted
callbacks, a main-wide admission barrier or complete trusted owned-resource
inventory. Native child exit/ownership adapters and installed lease/report/release
integration remain unfinished. Channel cancel does not prove child exit.
Production service start/stop, automatic recovery, stale-lock repair, backup
restoration and reset-to-empty remain disabled. Windows, business log/health,
main-death active-model recovery, UI/manual and signed installed acceptance remain
open. #7 and native dependency #5 stay open with unfinished boxes unchecked.
