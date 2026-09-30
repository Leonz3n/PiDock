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
