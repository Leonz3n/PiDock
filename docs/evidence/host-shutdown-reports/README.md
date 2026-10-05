# Main-Owned Durable Shutdown Report Experiment

Later [main release/native exit evidence](../host-release-native-exit/README.md)
adds a bounded experimental consumer that waits for every actual native exit
before writer disposal. Installed release/inventory adapters remain missing.

Follow-up to [SDK shutdown preparation](../host-shutdown-preparation/README.md).
This slice joins the experimental main store, current Host lease, bounded parent
acknowledgement, real SDK worker disposal and native service controller drain.
It is not installed production `task/quit` or service start/stop integration.

## Durable Report And Release Guard

The existing private POSIX journal adds an optional `shutdown` report containing
only `schemaVersion/taskId/hostEpoch/status`. Checkpoint-only envelopes remain
accepted; unknown envelope/report fields are refused. Old readers that do not
support the optional field must fail closed rather than downgrade the record.
The report is published with the same 64-KiB bounded primary/backup staging,
file fsync, rename, directory fsync and readback chain as the service entries.
There is no separately committed report file to disagree with the journal.
No paths, PIDs, argv, credentials or configuration fingerprint are added.

For closing, main verifies actual current Host object/epoch, task/project identity
and the exact lease/catalog service set. Every bound service must have a write
in this epoch and a durable `stopped`/`exited` entry with null ownership. Missing,
starting/running/stopping/unconfirmed or newly added/removed services prevent
closing. Old terminal records alone cannot authorize a fresh Host's report.
Identity, catalog, journal stamp and native Host revocation are checked again
between staging and primary replacement. Publication failure fences the lease,
including failure after primary replacement. No automatic retry/backup recovery.

Report publication seals checkpoint writes for that lease. `verifyShutdown`
revalidates before a delayed positive ack is sent. `confirmShutdown` consumes one
confirmation only after main receives the current actual Host's successful
post-ack completion message, then revalidates identity/catalog/stamp/report.
Foreign senders, native exit, stale epochs, repeated confirmation and external
journal changes refuse confirmation. The journal's presence is not confirmation.

Neither operation kills a Host or revokes its lease. The demonstration consumer
records whether release is permitted; it then explicitly stops the test utility.
`store.dispose()` remains unavailable until all actual native Host exits revoke
the leases, and still means **metadata writer disposal**, not process-tree proof.
A production caller must tie validation and its release action to the same
current instance; this API is a snapshot, not atomic OS release authorization.

## Parent Transport And Host Ordering

`experimentalShutdownClient` uses a dedicated trusted parent transport, one
request/id and a cached receipt. Scope is snapshotted, task/UUID/deadline checked,
report bounded to 512 bytes and ack fields required exactly. Send is not durable
acknowledgement. Timeout (default 5s), disconnect, negative/malformed/foreign or
duplicate ack and potentially sent transport exceptions fence the client.
Late acknowledgements do not repair it or cause resending. Coordinator lease
verification still happens after the acknowledgement.

The utility experiment now opens a real `SdkContextClient` worker with **zero
tools** and no model prompt. Its synchronous `seal()` fences future calls before
shutdown. `ExperimentalHostShutdown` then awaits SDK disposal, closes the real
service controller, waits its terminal checkpoint acknowledgement, publishes the
report through main and waits report ack before returning a closed result. The
fixture has no active model turn; `settleTurns` is a fulfilled no-turn callback,
not evidence of active-turn journal settlement. The prior production Provider
shutdown and SDK bridge evidence remains separate.

The new request/client/store APIs are internal experiments only. No renderer or
production IPC allowlist, Host entry, production service control or installed
artifact discovery enables this path. Scripts remain excluded from packaging.

## Verification

```sh
pnpm turbo run typecheck test build lint --force
pnpm --filter @pidock/shell smoke:shutdown-report
pnpm --filter @pidock/shell smoke:async-checkpoint
pnpm --filter @pidock/shell smoke:supervisor
pnpm --filter @pidock/shell smoke:recovery
```

Final full gate: `/tmp/pidock-report-gate-final2.log`, 8/8 tasks successful;
shell 87 files, 1136 passed / 1 existing Windows-only skip; renderer 77 files,
609 passed. 15 added cases: 6 main store/report guards and 9 transport cases.
Tests cover missing/unknown terminals, fresh epoch and stale sender, exact
membership, malformed/extra report fields, native exit and identity change
while staging, post-rename fsync failure, external valid-content change,
one-shot confirmation, post-report write sealing, scoped ack, timeout/late ack,
disconnect, duplicate/foreign/negative/extra ack, send exception and invalid
scope/deadline. Existing controller, recovery, SDK and main tests remain green.

Optional test-inclusive `tsc` still has 72 pre-existing diagnostics. Normalized
line/column comparison to the preceding slice has no additions or removals.
Log: `/tmp/pidock-report-test-types-final2.log`. It is not a passing optional gate.

Actual macOS arm64 Electron 44.4.3 / Node 24.21.0, main TaskRootIndex/ProjectRegistry/
catalog/private store -> actual utility sender/epoch -> real SDK worker -> native
development supervisor/Go service fixture:

- `close`: SDK worker and owned fixture stop, terminal checkpoint is acked, main
  journal contains stopped entries plus report while report ack is deliberately
  held. The utility has not returned close, main has not confirmed release, and
  writer disposal is refused. Releasing ack permits the Host result and one main
  confirmation; repeated close does not repeat confirmation.
- `lost-ack`: main has published the report but withholds ack until the client's
  5s timeout. Host reports failure; delayed ack/repeated close cannot repair it
  or obtain main confirmation, despite observed fixture resources being gone.
- `catalog-revoked`: a new service binding after publication invalidates the old
  exact inventory before delayed ack delivery. Main emits a negative ack, the
  Host fails closing and main retains release refusal.
- `host-death`: actual SIGKILL after report publication but before ack revokes
  the lease. Fresh actual utility gets a fresh epoch and cannot confirm/adopt the
  old report; old sender confirmation also fails. No launch is sent to fresh Host.

Log: `/tmp/pidock-report-utility-final2.log`. Synthetic native environment value
and SDK credential are absent from journal, utility messages and captured output;
profile path is absent from journal. PIDs/native-exit observations and emergency
cleanup are fixture evidence only, not recovery authority or production cleanup.

Regressions: `/tmp/pidock-report-async-regression.log` (previous four actual async
native scenarios), `/tmp/pidock-report-supervisor-regression.log` (nine original
native cases), `/tmp/pidock-report-leases-regression.log` (two actual metadata
Hosts). Original probes retain their own adapters/contract; their success is not
proof of report integration into those paths. The original parent-exit case is
not a new actual main-crash/restart test of this report store.

## Failure Record And Remaining Gates

Later [actual main death evidence](../main-death-recovery/README.md) demonstrates
running and held-report main SIGKILL plus refused restart under the unchanged
writer lock. It does not implement stale-lock repair or installed recovery.

No red implementation test or actual report probe occurred in this slice. The
optional baseline typecheck remains red as described above; its result was not
reclassified. Earlier failure history is retained in the linked documents.

An actual main SIGKILL/restart with this new report remains untested: its retained
`writer.lock` is intentionally not stolen, deleted by guessed PID, or repaired by
a timeout. Trusted stale-lock repair and durable whole-profile/journal presence
markers remain blockers. Both primary+backup deletion is not authenticated.

Still missing: installed SDK/bootstrap/lease/report transport, all-tool sealing
and complete service inventory across actual production workflows, bounded
release/native-exit handshake, active-model shutdown fault races, real main death
report recovery, Windows ACL/cwd/Job and reparse-point machine evidence, signed
installed artifact discovery/atomic execution, business environment/log/health
acceptance and UI/manual completion. Same-UID arbitrary shell/service filesystem
access, digest as non-MAC, path check/open races and sandbox limitations remain.
No renderer implementation changed or new screenshot acceptance is claimed.
#7/#10/#47/#24 stay OPEN with incomplete acceptance boxes untouched; the unrelated
untracked research document remains untouched.
