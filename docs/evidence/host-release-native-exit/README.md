# Main Release And Native Exit Experiment

Later [SDK admission/active quit evidence](../sdk-turn-admission-quit/README.md)
seals the installed Host turn transport and exercises real SDK/loopback model
streams during quit. Complete service/tool inventory and installed experimental
report/release integration remain missing.

Follow-up to [durable shutdown reports](../host-shutdown-reports/README.md) and
[presence witnesses](../recovery-presence-witnesses/README.md), for
[issue #7](https://github.com/Leonz3n/PiDock/issues/7). This closes an experimental
main-consumer ordering gap, not installed runtime/service-control integration.

## Contract

`ExperimentalHostRelease` snapshots a bounded, nonempty list of trusted actual
Host adapters (maximum 128), with distinct task IDs and sender objects and valid
current UUID epochs. An adapter is a main-owned transport closure, not a renderer
or Agent-supplied completion/sender, PID lookup or process-existence guess.

`close()` caches its promise before synchronously sealing main admission. The
caller must prevent any new Host/service/SDK ownership from entering the captured
inventory. Native exit listeners attach before close requests. All captured Hosts
are asked to close within one shared closing budget; no Host is released until
all successful completions are scope-validated and consumed by their real lease's
`confirmShutdown(actualSender, report)`. Missing/foreign/extra-field receipts,
lease confirmation failure and native death before confirmation refuse release.
Publication alone and old reports never satisfy this step.

After all confirmations, main rechecks the inventory and requests cooperative
exit from each captured Host. Sending a request does not prove exit. A separate
shared native-exit budget waits for every actual exit callback, backed by the
same Host adapter's `hasExited()` observation. Only then, after another inventory
verification, may the metadata writer be disposed. The default budget is 5s per
phase, configurable from 10ms to 60s. It is not a hard deadline for arbitrary
synchronous dependency code or underlying SDK/service work.

Timeout, failed seal/send/confirmation/disposal, unexpected exit or changed
inventory produces only `host-release-unconfirmed`. Native death after a release
request still needs the actual event/observation; the gate does not infer a clean
exit code. Successful siblings may already have exited when a later release-send
fails; this remains unknown, not all-or-nothing OS process termination. Listeners
are detached, receipt failure is cached, and late close/native exit cannot repair
it, consume additional confirmations, trigger writer disposal or retry release.

The caller's trusted `verify()` remains essential: it must validate the frozen
complete inventory, identities and durable report context before release and
writer disposal. This class does not discover Hosts, prove SDK/model/service
shutdown by itself or make snapshot validation atomic with OS exit. In the actual
probe it rechecks TaskRootIndex/ProjectRegistry identity, catalog membership,
witness bytes and published report bytes. These are not production adapters.

## Verification

```sh
pnpm turbo run typecheck test build lint --force
pnpm --filter @pidock/shell smoke:host-release
pnpm --filter @pidock/shell smoke:shutdown-report
pnpm --filter @pidock/shell smoke:supervisor
pnpm --filter @pidock/shell smoke:main-death
pnpm --filter @pidock/shell smoke:async-checkpoint
```

Final full gate: `/tmp/pidock-release-gate-final2.log`, 8/8 tasks successful;
shell 89 files, 1164 passed / 1 existing Windows-only skip; renderer 77 files,
609 passed. 18 added focused cases: 17 release ordering/failure cases and one
real-store confirmation/native-revocation/disposal integration case. The latter
proves the store retains its writer lock after confirmation until actual Host
revocation, refuses disposal while active and invalidates the old lease after
exit. Multiple-Host barrier, partial send failure, shared close deadline and
late-success refusal are unit evidence, not real multi-Host execution evidence.

Initial missing-module red: `/tmp/pidock-release-red.log`. The shared-budget
regression reproduced sequential timeout accumulation before the correction:
`/tmp/pidock-release-budget-red.log`. Final focused 18/18:
`/tmp/pidock-release-focused-final2.log`. Optional test-inclusive tsc remains red
with the same 72 baseline diagnostics, byte-identical before/after logs:
`/tmp/pidock-release-test-types-before.log` and
`/tmp/pidock-release-test-types-final2.log`. It is not a passing optional gate.

Actual macOS arm64 Electron 44.4.3 / Node 24.21.0 main -> utility Host -> real
SdkContextClient worker (zero tools, no model prompt) -> native development
supervisor/Go service fixture -> terminal checkpoint/report acknowledgement:

- `held-native-exit`: all terminal/report acks and main lease confirmation finish;
  explicit test withholding of the exit send keeps the Host alive. After 50ms,
  the close promise is still pending, writer lock remains and disposal has not
  happened. Cooperative fixture release then produces actual native exit code 0
  and only afterward coordinator-authorized writer disposal.
- `exit-timeout`: report is confirmed but test suppresses exit send. Native-exit
  deadline fails with writer lock retained and no authorized disposal. Sending
  release later makes the Host exit but cannot repair the cached failed receipt.
- `death-before-report-ack`: main publishes the report, then SIGKILLs the actual
  utility before ack. The lease is revoked without post-ack main confirmation;
  coordinator release and writer disposal remain refused despite native death.

Log: `/tmp/pidock-release-electron-final.log`, `HOST_RELEASE_UTILITY_OK`. The
output's `nativeExitObserved` is the final observation, including deliberately
late exit, not proof that a failed decision was repaired. Unknown scenarios have
explicit test-only disposal after actual native exit for fixture cleanup. No
recovery or installed caller may adopt that cleanup as authorization. Synthetic
native env and SDK credential are absent from journal/witness/messages/output;
report bytes remain unchanged after decisions and late native exits.

Regressions passed: `/tmp/pidock-release-report-final.log` (four report scenarios),
`/tmp/pidock-release-supervisor-regression.log` (nine native supervisor scenarios),
`/tmp/pidock-release-main-death-regression.log` (running/held-report SIGKILL plus
refused restart), `/tmp/pidock-release-async-regression.log` (four async scenarios).
Running main-death again observed one fixture PID after restart; PID observation
still cannot prove identity, active execution, complete tree exit or recovery
permission. Neither stale locks nor recovery history were repaired or removed.

## Remaining Gates

This class is not imported into production runtime, installed Host/RPC or
renderer. The fixture adds a cooperative release operation gated by successful
experimental shutdown; scripts remain excluded from packaging. Production
service start/stop remains unavailable. No all-tool/active-model shutdown,
complete production owned-service inventory, installed admission/report/release
wiring, signed artifact atomic execution or Windows ACL/cwd/Job proof is claimed.
Trusted stale-lock repair, legacy migration and lifetime-reservation retention
contracts remain missing. Profile/witness/journal evidence is not an external
trust anchor and does not permit inferred recovery.

Independent subagent review remains unavailable because the installed host/core
packages lack the required `@earendil-works/pi-agent-core/node` export; no new
independent review is claimed and no alternate CLI was substituted. Parent
verification and regressions above are the evidence actually obtained.
#7/#10/#47/#24 remain open with incomplete acceptance boxes unchecked. No renderer
or UI screenshot changed; the unrelated untracked research document is untouched.
