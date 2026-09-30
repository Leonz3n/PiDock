# Main-Owned Checkpoint And Host Lease Experiment

This follows the [service lifecycle experiment](../service-execution-lifecycle/README.md).
It does not enable production `task/controlService`, `task/quit`, or `host-entry.ts`.
The checkpoint lease is metadata write authority, not approval, execution authority,
configuration authentication, service ownership adoption, or a safe application quit receipt.

## Storage And Lease Contract

- `ExperimentalServiceRecoveryStore` is constructed only by a trusted main caller
  with an application profile, task/project authority, and catalog-backed service ID supplier.
  Incoming requests cannot supply a storage path, task identity, program, or environment.
- POSIX experiment: current-user-owned profile must not be group/world writable;
  the recovery directory is 0700 and files are 0600. Windows is unavailable rather
  than interpreting POSIX mode bits as verified Windows ACL protection.
- The profile/directory identities and open directory/writer descriptors are checked.
  Reads are bounded to 64 KiB, use `O_NOFOLLOW`/`O_NONBLOCK`, and reject links,
  hardlinks, special files, broad permissions, changed identities or read snapshots.
  These are observed snapshot checks, not atomic directory-relative filesystem authorization.
- An exclusive `writer.lock` prevents a second store from writing the same directory.
  Its open descriptor is retained. No PID probe, timeout, or automatic stale lock theft
  is implemented. Unclean main termination can leave a lock that blocks reopening;
  trusted recovery/repair remains a production blocker, not an implicit reset.
- Journal filenames derive from task IDs. Each strict envelope contains only schema
  version, task ID, identity digest, last writing Host epoch, and checkpoint entries.
  Entries retain the existing five-field, 2048-byte schema. No PID, path, argv,
  credential, private reference, approval, or execution config fingerprint is persisted.
  The identity digest is a comparison key, not a signature or MAC.
- Writes stage and fsync temporary files, publish a prior-state backup and primary
  using rename, fsync the directory, and check the resulting contents. Missing or
  malformed primaries do not restore backups or become empty state. First publication
  backs up the new record too, so a backup without primary remains an explicit failure.
- Partially successful writes can leave the new primary visible while returning an
  error. The lease is fenced until its registered owner exits; the caller cannot blindly
  retry or infer that no record was written. Out-of-band valid content changes are
  also detected against the lease's last acknowledged content stamp and fence it.
- Main binds a lease to a task identity, catalog service IDs, an opaque actual Host
  instance object, and a fresh epoch. One task has one active lease; one Host instance
  cannot hold two task leases. Distinct task leases do not share lifecycle state.
- Every request verifies actual sender object identity, epoch, exact message fields,
  current task/project identity, and registered service membership. Membership and
  identity are checked again after staging before publication. New bindings do not
  implicitly expand a live lease. Unbound nonterminal records block a replacement lease.
- Only the trusted main owner's native exit subscription revokes the lease. A JSON
  `exited` claim does not do so. Old ports, old epochs, foreign senders, and delayed old
  callbacks cannot modify a replacement Host's record.
- Recovery still normalizes interrupted checkpoints to `unconfirmed` in the lifecycle
  controller, without launching, replaying, adopting a PID, or clearing verification gates.
  Store `dispose()` only closes metadata ownership after all registered Hosts exit;
  it does not certify service termination or replace lifecycle drain.

## Actual Evidence

Development machine: macOS arm64, Node 24.21.0. Electron probes report Electron
44.4.3 and its Node 24.21.0 for each utilityProcess.

### Focused And Full Checks

19 new tests cover disk persistence, permissions, separate task leases, duplicate
Host/task binding rejection, sender/epoch/request validation, native-owner callback
revocation, task/project/service changes, overlap, recovered interruption, missing/
corrupt/foreign/oversized records, numeric IDs, corrupt backups, links/hardlinks,
profile/parent/directory replacement, stale locks, out-of-band changes, and failures
both before publication and after rename.

A real TaskRootIndex/ProjectRegistry/ServiceCatalog fixture backs the main storage
adapter. The lifecycle integration test restores a running sample as unconfirmed and
never invokes its executor. Other owner callback tests use controlled main-side
fixtures; they are not Electron or physical process-tree evidence.

Final `pnpm turbo run typecheck test build lint --force`: **8/8**, zero cached.
Shell: **1060 passed, 1 Windows-only skipped**. Renderer: **609 passed**.
Log: `/tmp/pidock-gate-recovery-leases-final2.log`.

The optional test-inclusive `tsc -p tsconfig.json --noEmit` check is **not green**.
A temporary `git archive HEAD` baseline with the same dependencies yields the exact
same **72 diagnostics**, with no additions or removals. The normal repository
`typecheck` uses `tsconfig.build.json` and passes. Existing test type errors were not
silently repaired or hidden by changing the standard gate.
Logs: `/tmp/pidock-recovery-test-types-baseline.log` and
`/tmp/pidock-recovery-test-types-final2.log`.

### Real UtilityProcess Checkpoint Probe

After shell build, `pnpm --filter @pidock/shell smoke:recovery`:

- Main builds a real isolated catalog and owns all checkpoint filesystem operations.
  Two actual utilityProcess objects relay metadata requests, with no filesystem,
  executor, SDK, or production RPC imports in the fixture.
- Main replies only after its synchronous durable storage operation returns.
  Disk readback matches the acknowledged sample. The sample is deliberately
  `unconfirmed`, not a fabricated service start/stop success.
- Cross-Host sender attempts, old epochs, path fields, private environment fields,
  and a forged `exited` field are refused. A second lease is unavailable while the
  first actual Host remains alive.
- After actual native utilityProcess exit, replaying its captured request through
  the old main receiver is refused. The other actual Host acquires a distinct epoch,
  reads the conservative record, rejects the old epoch, and writes its own envelope.
  No old message clears or overwrites the current record.
- Synthetic private value is absent from replies, utility stdout/stderr, and journal.
  Program/profile paths are absent from the journal. This is metadata transport
  evidence only: no service was launched and no process tree was adopted.

Final log: `/tmp/pidock-recovery-leases-utility-probe-final.log`.
The existing `smoke:supervisor` nine lifecycle scenes also passed again, including
real native stop/disconnect, Host/supervisor termination, cancellation, close and
recovery without replay. They still use their previous test-only recovery adapter;
this run does **not** prove that the new main store backs their lifecycle controller.
Log: `/tmp/pidock-recovery-leases-utility-regression-final.log`.

### Failures Retained

The first new typecheck failed because an inferred arrow-form `never` helper did
not participate in TypeScript control-flow narrowing. It was changed to a function
declaration; the normal typecheck and subsequent full gates pass. This was not a
runtime journal failure or a weakened validation condition.

The first new Electron checkpoint probe timed out at startup. Its ESM entry used
top-level `await run()` while `run()` awaited `app.whenReady()`, preventing entry
completion/readiness. It now uses the repository's existing `void run()` entry
pattern and explicit bootstrap stages. The deadline and success checks were not
relaxed. First failure: `/tmp/pidock-recovery-leases-utility-probe.log`; first fixed
run: `/tmp/pidock-recovery-leases-utility-probe-fixed.log`; final successful run is
listed above.

## Remaining Gates

The same-process `lease.port()` is an internal test adapter, not a synchronous
utilityProcess RPC. The current lifecycle controller requires a synchronous durable
port. Production transport needs explicit asynchronous main write acknowledgement,
bootstrap/recovery failure handling, cancellation, and revalidation after awaits,
while preserving write-ahead-before-spawn and claim lifetime. The metadata relay
probe does not implement that bridge or a main-to-Host execution capability.

The recovery directory is outside the task directory and does not have a task file
API here. This does not prove that every possible registered ordinary-directory
source excludes the application profile. Before production integration, protected
profile sources/aliases must be excluded by the trusted task-tool authorization
path. Mode bits and main-only APIs are not an OS sandbox: arbitrary same-UID shell
or service code can access/tamper with filesystem data, including this journal.
The digest/epoch is not cryptographic origin authentication against that actor.

Trusted main startup and stale-lock recovery, Windows ACLs and actual cwd/Job tests,
installed/signed supervisor discovery, atomic executable verification, actual
production SDK/service shutdown, full business environment, logs/health UI and
manual acceptance remain open. No renderer edits or new UI screenshot acceptance
occurred. The untracked research document was not edited or staged.

#7/#10/#47/#24 remain OPEN; no incomplete acceptance boxes are checked.
