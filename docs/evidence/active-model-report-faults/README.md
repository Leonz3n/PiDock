# Active Model Shutdown Report Faults

Follow-up to [installed SDK admission/quit](../sdk-turn-admission-quit/README.md)
and [main release/native exit](../host-release-native-exit/README.md), for
[issue #7](https://github.com/Leonz3n/PiDock/issues/7). This joins active real SDK
turns to the experimental service/report/release ordering. It does not install
that combined path into production service control or Host RPC.

## SDK Failure Guard

A dispatched SDK context could previously become dead before `dispose()`, skip
graceful disposal and return success from a valid cached termination receipt.
Termination proves neither a graceful SDK drain nor committed turn/session state.
`SdkContextClient` now remembers whether a non-shutdown context call was dispatched.
If such a context is already dead when shutdown begins, it retains
`sdk-context-shutdown-unconfirmed` even after successful termination. Disposal
still attempts termination once and keeps the same failed promise; no private
worker/protocol error detail is added to the shutdown receipt.

This covers active worker error, unexpected native exit and protocol poisoning,
and an idle dispatched context's unexpected exit (including code 0). A failed
bootstrap before any context request is dispatched keeps its existing cleanup
behavior; this change does not permanently block legitimate pre-dispatch retries.
The old poisoned-protocol test's successful-disposal expectation is deliberately
changed to cached failure. Other bootstrap/normal-disposal contracts are unchanged.

## Combined Actual Probe

`smoke:active-model-report` explicitly opts the development utility fixture into
a real SDK worker/router/turn transport. The fixture keeps the old zero-prompt
behavior when this option is absent. The new probe uses:

main TaskRootIndex/ProjectRegistry/catalog/private store/current actual Host lease
-> utility -> real isolated SDK Worker/AgentSession -> loopback OpenAI-compatible
SSE Provider -> real development native supervisor/Go service hierarchy -> terminal
checkpoint acknowledgement -> shutdown report acknowledgement -> main release
coordinator -> actual Host native exit -> authorized metadata writer disposal.

Every scene begins with both a running owned service fixture and a real model
request/streamed delta. Provider sees one configured-model request with the explicit
credential and zero tools. Main rechecks captured identities/inventory, witness
bytes and published report bytes. All observed exact native fixture processes
are gone after service cleanup; these fixture observations do not discover or
prove a complete production process tree.

| Scene | Model Turn Journal | Report Published | Main Confirmation / Authorized Disposal |
| --- | --- | --- | --- |
| active-close | cancelled | yes, held ack first | yes, only after ack/completion/native exit |
| worker-death | failed | no | refused |
| protocol-fault | failed | no | refused |
| missing-termination-receipt | cancelled | no | refused |
| terminal-write-denied | original accepted remains | no | refused |
| lost-report-ack | cancelled | yes | refused |

`worker-death` terminates the actual active SDK Worker. `protocol-fault` deliberately
injects a foreign protocol reply into the real Worker's **parent-side adapter**;
it is not a packet spontaneously emitted by the production worker. That poisons
the real client, terminates the actual active SDK context and retains a real
successful cached termination receipt. The injected fault makes the old code's
incorrect closed report reproducible, without substituting a fake model worker.

`missing-termination-receipt` runs the actual SDK disposal/native termination but
injects a never-resolving return receipt into the terminate adapter. Native exit
is independently observed; it still cannot repair the failed SDK disposal.
`terminal-write-denied` applies real POSIX mode 0500 to the test-only turn journal
directory after acceptance. Terminal publication/reconciliation fails with no
successful terminal status acknowledgement. The accepted record is not rewritten
as invented success. Restoring 0700 later and repeating close do not repair the
cached failed Host/main receipt. This is actual permission failure, not a file
fsync crash/disk-loss simulation and not Windows ACL evidence.

All negative scenes still drain the captured service into durable stopped/null
ownership entries. They do not issue a closed report when SDK/turn evidence is
unknown. Lost report ack retains publication but no consumption/confirmation or
release, even when SDK and service are observed gone. Repeated close, late report
ack and late permission repair do not resend the report or authorize release.
Unknown scenes retain their writer lock while Host remains alive; explicit native
Host kill and store disposal afterward are **test cleanup**, not gate permission.
Synthetic credentials/native env values are absent from journal/witness/SDK JSONL,
messages and Host output; report bytes remain unchanged after decisions.

## Verification And Failure Record

```sh
pnpm turbo run typecheck test build lint --force
pnpm --filter @pidock/shell smoke:active-model-report
pnpm --filter @pidock/shell smoke:active-turn-quit
pnpm --filter @pidock/shell smoke:shutdown-report
pnpm --filter @pidock/shell smoke:host-release
pnpm --filter @pidock/shell smoke:supervisor
pnpm --filter @pidock/shell exec node scripts/sdk-shutdown-test.mjs
pnpm --filter @pidock/shell exec node scripts/sdk-context-isolation-test.mjs
```

Full gate `/tmp/pidock-active-report-gate-first.log`: 8/8; shell 90 files,
1174 passed / 1 existing Windows-only skip; renderer 77 files, 609 passed.
Four added SDK client tests plus the corrected existing protocol expectation.
Focused SDK client/provider/Host shutdown/turn shutdown suite 45/45:
`/tmp/pidock-active-report-focused.log`.

New SDK client tests first reproduced the defect:
`/tmp/pidock-active-report-dead-context-red.log`. The first implementation run
also found the old poisoned-protocol success assertion:
`/tmp/pidock-active-report-dead-context-green-first.log`; it was corrected as
specified above, not hidden or classified as a passed run.

The initial five-scene probe against the preceding compiled SDK client was green
(`/tmp/pidock-active-report-electron-red.log`, despite the tentative filename):
Node's already-exited Worker returns an unusable termination value, and that
separate guard already refused shutdown. After adding deliberate protocol poisoning
with a cached real termination receipt, the old build reproduced erroneous report
publication: `/tmp/pidock-active-report-electron-red2.log`, failing protocol-fault
`true !== false`. Rebuilding the fixed client passed all six actual scenes:
`/tmp/pidock-active-report-electron-green.log`, `ACTIVE_MODEL_REPORT_OK`, on
macOS arm64 Electron 44.4.3 / Node 24.21.0. Repeated final six-scene run:
`/tmp/pidock-active-report-electron-final.log`. The first probe was not a red reproduction.

Optional test-inclusive tsc still has the same 72 baseline diagnostics, byte-identical
to `/tmp/pidock-turn-seal-test-types.log`; current log
`/tmp/pidock-active-report-test-types.log`. This optional gate is not passed.
Regressions passed: `/tmp/pidock-active-report-quit-regression.log` (three installed
Host active-turn scenes), `/tmp/pidock-active-report-report-regression.log` (four
report scenes), `/tmp/pidock-active-report-release-regression.log` (three release
scenes), `/tmp/pidock-active-report-supervisor-regression.log` (nine native scenes),
`/tmp/pidock-active-report-worker-regression.log` (three Worker transport faults),
`/tmp/pidock-active-report-isolation-regression.log` (real SDK credential isolation),
`/tmp/pidock-active-report-main-death-regression.log` (two SIGKILL/refused-restart
scenes) and `/tmp/pidock-active-report-async-regression.log` (four async scenes).
Running main death again observed one fixture PID after restart; it still does
not prove identity, activity, complete tree exit or recovery permission. Writer
lock/history/witness remained unchanged; no stale lock was repaired or removed.

## Remaining Gates

No production service start/stop or automatic recovery is enabled. Installed
combined SDK/service lease/report/release wiring, all-tool sealing and complete
production owned-resource inventory remain missing. Model tools are zero here;
loopback Provider and development unsigned native fixtures do not prove external
business model/service acceptance or signed artifact atomic execution. Active-model
main SIGKILL and trusted report/crash recovery, stale-lock repair, migration/retention,
Windows ACL/cwd/Job, business environment/log/health and UI/manual gates remain.

Independent subagent review remains unavailable due to the previously recorded
installed host/core `./node` export incompatibility; no independent approval or
alternate CLI fallback is claimed. #7/#10/#47/#24 remain open with incomplete
acceptance boxes untouched. The unrelated research document remains untouched.
