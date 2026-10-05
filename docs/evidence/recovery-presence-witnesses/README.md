# Recovery Initialization And Task Presence Witnesses

Follow-up to [actual main death](../main-death-recovery/README.md).
The implementation foundation was submitted as `3cb8170`; this follow-up makes
witness read failures sticky and adds actual separate Electron main probes.
Production service control, installed startup and report integration remain
unavailable. This is a POSIX metadata experiment, not automatic crash recovery.

## Contract

The private profile contains `service-execution-recovery.witness.json` outside
`service-execution-recovery/`. Its strict schema records the profile identity
digest, recovery directory device/inode, and a map of hashed task IDs to trusted
task identity digests. It contains no task names, paths, PIDs, commands,
credentials, approvals or shutdown/restart authorization. It uses the same
bounded non-following, single-link, current-user private-file reader as journals.
The witness is bounded to 64 KiB and 400 lifetime task reservations; there is no
automatic pruning, reset or migration API. This cap is an experimental limit,
not a production task-retention design.

Only a missing witness **and** a newly created recovery directory can initialize
a new store. An existing directory without a witness is unavailable, including
legacy experimental stores. A surviving witness with a missing or replaced
recovery directory is unavailable without recreating the missing directory.
A missing/corrupt/public/linked witness is not automatically reconstructed from
journals. A clean writer restart accepts the same profile/directory identity;
normal disposal removes only the writer lock, not the witness.

Before the first checkpoint/report journal publication for a task, main stages
and fsyncs a new witness, verifies current paths, task identity and native Host
liveness, renames it, fsyncs the profile directory and reads it back. Only then
may primary/backup publication proceed. The first publication has an internal
single-use missing-journal allowance after its own successful reservation; it
is not exposed on acquire, RPC reads or later writes. Missing primary plus a
recorded reservation refuses as `service-recovery-primary-missing`, even when
backup is also absent. A primary without a matching reservation also refuses.

A failed reservation fences the whole writer and does not remove its lock;
unknown partial publication cannot be blindly retried. Successful reservation
followed by Host exit before journal publication leaves a durable reservation
and a missing journal; the next lease refuses instead of inventing absence.
Out-of-band witness changes and witness reader failures permanently fence the
current writer, including after external restoration of the original bytes.
Temporary-file cleanup requires the original directory/lock context and file
identity; unknown or redirected paths are retained rather than cleaned blindly.
A fenced store can retain open metadata handles until main exits; no repair or
force-dispose interface is introduced.

## Verification

```sh
pnpm turbo run typecheck test build lint --force
pnpm --filter @pidock/shell smoke:recovery-presence
pnpm --filter @pidock/shell smoke:main-death
pnpm --filter @pidock/shell smoke:shutdown-report
pnpm --filter @pidock/shell smoke:async-checkpoint
pnpm --filter @pidock/shell smoke:recovery
```

- Full gate `/tmp/pidock-presence-gate-final.log`: 8/8 successful; shell 87 files,
  1146 passed / 1 existing Windows-only skip; renderer 77 files, 609 passed.
- Store-focused `/tmp/pidock-presence-followup-focused.log`: 35 passed, including
  10 new tests across the foundation and follow-up.
- Optional test-inclusive typecheck `/tmp/pidock-presence-test-types-final.log`
  remains red with the same 72 baseline diagnostics. Exact output comparison
  against `/tmp/pidock-presence-test-types-before.log` has no differences.
- New actual main probe `/tmp/pidock-presence-electron-first.log`: six scenarios
  passed with `RECOVERY_PRESENCE_OK`, Electron 44.4.3 / Node 24.21.0, macOS arm64.
  The Node parent runs seed and reopen in separate real Electron processes using
  actual TaskRootIndex/ProjectRegistry/catalog and actual metadata utility Host.
- Healthy reopen reads the persisted **unconfirmed** sample without rewriting
  journal/backup/witness. Both journals deleted permits a metadata writer and
  actual metadata utility startup but refuses its lease. Recovery directory
  deleted/replaced and witness deleted/corrupt refuse construction before any
  utility spawn. No executor/native service/SDK/model is connected in this probe;
  zero service launch attempts are structural, not a business launch acceptance.
  Surviving evidence content, inode/device, mode, size and timestamps are checked
  unchanged. Missing directory, journal and witness paths are not recreated.
- Main-death regression `/tmp/pidock-presence-main-death-regression.log`: running
  and held-report SIGKILL scenarios passed. Snapshots now include the witness in
  addition to lock/primary/backup. Live contender and fresh restart both refuse;
  witness remains unchanged. Running still observes one native fixture PID at
  500ms; held-report observes none. PID existence is not identity, activity,
  complete tree exit or recovery authority. Emergency cleanup remains test-only.
- Report regression `/tmp/pidock-presence-shutdown-report-regression.log`: close,
  lost-ack, catalog-revoked and Host-death passed with the expected confirmation
  differences. Publication without ack still cannot authorize release.
- Async checkpoint and metadata-lease regression logs:
  `/tmp/pidock-presence-async-regression.log` and
  `/tmp/pidock-presence-leases-regression.log`; success markers checked.

## Failure And Review Record

`/tmp/pidock-presence-red.log` records the original seven failing tests before
implementation. `/tmp/pidock-presence-followup-red.log` passed because the initial
fixture used nonempty corrupt bytes, which already exercised the content-mismatch
fence. The corrected zero-length reader-failure fixture failed in
`/tmp/pidock-presence-followup-red2.log`: restoring the witness incorrectly allowed
a read. The follow-up caches all witness-reader failures, not only comparisons.
No deadline or refusal condition was relaxed. Historical failures remain retained.

Independent subagent review did not start: workflow
`e879fc0b-a258-47f2-b27a-0c54e3f8214a`, requested child
`c401de85-e73f-41bf-8ccc-0783a52f4457`, failed because the installed global
`@earendil-works/pi-agent-core` 1.0.2 does not export
`@earendil-works/pi-agent-core/node`, required by the background runner.
No review artifact/session was created. After reporting the blocker and preserving
`/tmp/pidock-presence-partial.patch`, the user explicitly requested submission and
continued progress. The parent continued directly; there is no claim of an
independent review, no alternate CLI fallback, and no global tool modification.

## Limits And Next Gates

Deleting both the recovery directory **and** its sibling witness, deleting the
whole profile, or coordinated same-UID modification/rollback of witness and
journals remains undetectable without a trusted external anchor. Digests and
file metadata are comparison keys, not MACs, signatures, OS exclusivity or a
same-UID sandbox. The use-time filesystem checks remain snapshots, not atomic
filesystem authorization. An initialized store surviving a single-location loss
is now protected; complete profile deletion protection is **not** claimed.

Reservations are evidence that history must exist, not proof that services are
stopped or that a prior closed-report ack was delivered/consumed. Stale writer
locks remain untouched on restart. No PID guessing, timeout stealing, backup
restore or reset-to-empty was added. Trusted exclusive repair, legacy migration
and lifetime reservation retention still need their own explicit contracts.

Installed bootstrap/report transport, all-tool sealing and complete owned
inventory, release/native-exit handshake, active model shutdown faults, signed
installed artifacts/atomic execution, Windows ACL/cwd/Job machine evidence, and
business environment/log/health/UI acceptance remain open. No renderer changes,
new screenshots or Windows execution are claimed. #7/#10/#47/#24 stay OPEN and
incomplete acceptance boxes remain unchecked. The unrelated research document
remains untracked and untouched.
