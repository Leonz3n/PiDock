# Service supervisor experiment

This is an isolated process-ownership experiment for issue #7. It is not used
by the Host, included in Electron packages, or an approved service executor.
Do not connect it to `task/controlService` on the strength of these tests.

Protocol (test-only): one JSON launch line on stdin with absolute `taskRoot`,
`cwd`, `program`, `args`, explicit `env`, and `graceMs` (50-3000). On macOS,
`rootIdentity` and `cwdIdentity` must each contain decimal-string `device`
and `inode` values obtained by a trusted caller before launch. Missing or
mismatching identities refuse launch. These are filesystem identities, not
JavaScript numbers (which could lose inode precision). Keep stdin
open; write `stop\n` to stop. The supervisor alone writes JSON `ready`, `exit`,
`stopped`, or `error` records to stdout. Service stdout/stderr both go to the
supervisor's stderr. No shell is inserted. Never display unredacted stderr or
store launch input; it may contain secrets.

On macOS, a separate process-group anchor watches a private pipe. On
supervisor death it signals its own group and then kills it. A descendant
which intentionally creates a different session/group is outside this
contract. On Windows, a child is created suspended, assigned to a Job Object
with `KILL_ON_JOB_CLOSE`, and only then resumed. If assignment fails, the
suspended child is terminated. A restricted inherited-handle list excludes
the status and control channels. Windows runtime behavior has **not** been
verified on Windows yet.

On macOS, cwd is opened component-by-component using `openat` relative to
an identity-checked root handle; symlink components below the root are refused.
The final handle must match the supplied cwd identity. `File.Chdir` uses
`fchdir`, so replacement after opening cannot redirect launch to a different
directory object. Renaming a pinned directory does not revoke it: this is an
object-identity guarantee, not continuous pathname containment or a filesystem
sandbox. Concurrent changes to file contents/programs are outside this check.

Host bridge experiment: `src/host/service-supervisor-experiment.ts` exposes a
single-run controller for tests only; it is not imported by production Host.
The caller supplies an explicit binary, already captured identities, a
redactor, and a log sink. The helper receives no inherited Host environment.
Ready and stop deadlines are bounded; a cleanup deadline may add one stop
window. Only a valid terminal receipt followed by clean supervisor/stdio
closure is confirmed. Missing/malformed/duplicate receipts, timeouts, abnormal
helper exit, and redactor failure are unconfirmed. Helper kill is never treated
as proof of descendant termination. Log lines are limited to 2000 characters;
oversized whole lines are replaced, not segmented, and at most 200 lines plus
one truncation marker are delivered per run. This is an experiment cap, not a
production rolling log. `completion` remains pending while a service runs;
call stop/disconnect to impose the termination deadline.

Run the bridge tests from the repository root (macOS real-helper tests require
Go on PATH; Windows protocol/runtime tests are not yet implemented):

```sh
pnpm --filter @pidock/shell exec vitest run src/host/service-supervisor-experiment.test.ts
```

Trusted preparation experiment: `src/main/service-supervisor-preparation.ts`
reads the exact persisted task binding/template through catalog authority,
derives the worktree/subdirectory (no page paths), captures decimal-string
root/cwd identities, and resolves only saved shared/private layers into a fresh
environment. A caller must explicitly supply a matching macOS architecture
artifact path and SHA-256; absent/wrong/unreadable/linked/overlarge/non-executable
artifacts refuse preparation. This caller-provided hash is an experiment input,
not a signed package manifest or proof of platform compatibility. The returned
object has no serializable launch/private values; a trusted callback consumes
it once after rechecking catalog, directory, program, and artifact snapshots.
Redaction includes raw and interpolated private values. No binary discovery,
production permissions, IPC transport, or automatic startup is added.

These checks are snapshots, not atomic filesystem authorization or atomic
execution of a verified binary. The native helper checks the captured root/cwd
identities again at launch; concurrent pathname/content changes and executable
replacement still need a supported production contract. No request should be
serialized to UI, logs, or disk. The experiment supplies no inherited toolchain
environment, task overrides, runtime bindings, or business-file configuration.
The preparation tests use real TaskRootIndex/ProjectRegistry/catalog files and
include replacement after the main check but before native launch.

Development artifact builds (Go on PATH):

```sh
pnpm --filter @pidock/shell build:supervisor:mac
pnpm --filter @pidock/shell build:supervisor:win
```

The scripts produce ignored `packages/shell/build/service-supervisor/` target
directories for macOS arm64 and Windows x64. Each contains a binary and strict
`manifest.json`: schema/protocol version, `development-unsigned` kind, target,
fixed filename, binary SHA-256, sorted local source-tree SHA-256, and host Go
version. Builds use CGO off, trimpath, readonly modules, no workspace/VCS/build
ID, and check the output Mach-O/PE target. With identical sources and toolchain,
repeat macOS builds are tested to produce identical binary hashes; this is not
a universal cross-toolchain reproducibility claim. Failed builds do not publish
a new manifest. An existing target is replaced only if its manifest identifies
the same development target; unrelated directories are left alone. Concurrent
same-target builds are not supported.

`inspectDevelopmentSupervisor` only reads an explicitly supplied development
directory. Bounded, non-following reads reject invalid/extra manifest fields,
unsupported schema/protocol, unsafe filenames, missing/linked binaries, content
hash mismatch, and mismatching machine headers. Only current macOS arm64 can
return `available-for-experiment`; Windows x64 remains runtime-unavailable even
with a valid cross-built artifact. These headers are structural checks, not
proof of a runnable/signed binary. The source digest is recorded provenance,
not a trusted release signature or automatic comparison with current checkout.
Changing both a local binary and its manifest can replace this development
artifact: do not treat the manifest as authentication. Final hashes must be
recomputed after release signing, which is not implemented here.

Normal shell build/dev/package scripts do not build, discover, or include
these artifacts. No Go installation is required for ordinary product builds,
though native experiment tests on macOS require Go. Explicit build output is
not evidence of Windows execution, installed-package availability, or signing.

Actual utilityProcess lifecycle experiment (macOS arm64 only):

```sh
pnpm --filter @pidock/shell build
pnpm --filter @pidock/shell build:supervisor:mac
pnpm --filter @pidock/shell smoke:supervisor
```

`scripts/electron-service-supervisor-smoke.mjs` creates an isolated profile,
real task/project/catalog records, and an explicit native fixture executable.
It consumes the development artifact manifest and private request preparation,
then transfers that in-memory request through Electron's parent port to
`scripts/service-supervisor-utility-fixture.mjs`. Neither script is a product
RPC endpoint or included in packaged `files`. The utility fixture redacts all
synthetic request env values before returning logs. The experiment requires Go
for the fixture and reports exact Electron/Node versions.

The six scenarios are stop, control-input disconnect, utility Host self-exit,
Host SIGKILL, supervisor SIGKILL, and service-parent exit. For each, the test
checks that this run's observed helper/service/descendant PIDs disappear, the
utility exits, and outbound messages/stdout/stderr/private metadata omit the
synthetic value. Host death has no terminal receipt; supervisor death remains
`unconfirmed` even when the test later observes resources gone. Those
observations are test evidence, not automatic production recovery state or a
PID-based production stop mechanism. No Windows acceptance or guarantee for
macOS descendants escaping the process group is inferred. The production Host
entry and `task/controlService` are unchanged and remain execution-unavailable.

Async execution-authority experiment: `src/host/service-execution-experiment.ts`
is a single-service controller used only by tests, never production Host. It
uses real PiSessionChannel approval records and TaskWriteCoordinator ports.
An absent driver refuses before minting/claiming/changing lifecycle. Callers
must supply the Host's actual bound channel and trusted config fingerprint;
snapshot identity checks are not authentication of a caller-provided channel.
There is no human/renderer entry or production enable switch.

Default-tier confirmations bind task/session, service, action, and fingerprint;
pending/rejected/foreign/stale/spent confirmations refuse execution. Spend is
persisted before acting, and permission/config are checked again after a
persistence await. The controller retains the write claim across async start
and stop, rejects duplicate control of this single service (including the same
session), and exposes owned uncertain/running resources for orphan checks.
Separate task coordinators remain independent. This is not a multi-service
same-session scheduler or cross-task shared-path lock.

States are stopped/starting/running/stopping/exited/unconfirmed. Ready and clean
terminal receipts come from the bounded supervisor driver, not marker-only
runtime methods. A rejected start may have spawned resources before failure:
without zero-resource proof it remains unconfirmed, owned, and non-restartable.
Unknown stop also retains ownership. Natural confirmed completion clears it.
The driver must be bounded (the experiment uses launchSupervisorExperiment).
Production cancellation/recovery persistence, approval rendering/adaptation,
human execution, health checks, installed artifacts and actual business
configuration are still outstanding. Existing synchronous marker-only service
control and production task/controlService are not changed by this controller.

Lifecycle follow-up (still test-only): the controller seals new requests on
close, waits for in-flight operations, drains owned live sessions and requires
acknowledged recovery storage before a safe-close report. Abort invalidates
pending approvals and cleans late ready sessions while retaining write claims.
A strict IDs/state/owner-only checkpoint is written before spawn; interrupted
records reopen unconfirmed, never replay or adopt PIDs. The trusted
verificationRequired resource flag also blocks the original owner's new write
claims. Production storage/epoch authority and SDK/Host lifecycle wiring are
not provided. The utility smoke now adds lifecycle-close/cancel/recovery to the
original six cases. Evidence: `docs/evidence/service-execution-lifecycle/README.md`.

During the async authority full-gate run, the existing real macOS bridge test
once returned native `termination-unconfirmed` rather than exit code 3, and a
repeat run also observed it on control disconnect. The bridge correctly kept
that failure unconfirmed. Targeted diagnostics did not isolate a root cause;
15 full bridge repetitions and 40 real-only repetitions then passed, but that
was not a fix. A later kqueue probe caught anchor wait status 512 (exit 2), and
a delayed-signal child reproduced the post-SIGKILL ordinary-exit race. The
anchor now waits for actual death after successful SIGKILL dispatch; failed
signals, abnormal waits and timeouts remain unconfirmed. Evidence and bounded
repeat commands: `docs/evidence/service-supervisor-anchor/README.md`.
No production gate is opened by this fix. Temporary debug logging was removed;
redacted assertion context is retained.

Outstanding production blockers:

- The Host must capture and bind trusted task-root and cwd identities to the
  helper; there is no production identity transport yet. Windows remains on
  the earlier experimental path check, ignores the macOS identity fields, and
  `File.Chdir` resolves a path again. No Windows cwd identity guarantee is claimed.
- The Host must own the helper's lifecycle, bound its readiness/stop and log
  streams, redact private values, and reject unconfirmed termination.
- The native binary needs platform-specific build, packaging, signing, and
  availability checks. Service recipes and credential references must be
  persisted separately before production execution is enabled.
- Windows Job behavior and cwd replacement need tests on Windows. No Windows
  platform acceptance is inferred from a macOS cross-compile.

Run from this directory:

```sh
go test -v -count=1 ./...
go vet ./...
```

On Windows, run the same commands in PowerShell from
`packages/shell/native/service-supervisor`. Tests launch a temporary fixture
for at most 30 seconds and exercise stop, parent exit, supervisor crash, and
cwd refusal. Report the exact failed test/output and Windows version before
any production wiring.
