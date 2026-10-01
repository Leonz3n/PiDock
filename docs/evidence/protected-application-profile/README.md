# Protected Application Profile Boundary

Follow-up to #7's main-owned recovery store and asynchronous durable-checkpoint
experiments. This slice does not enable production service start/stop or close an
issue. No renderer layout or interaction changed, so no new UI screenshot
acceptance is claimed.

## Implemented Boundary

- Main supplies only `app.getPath("userData")` to the production task Host via
  `buildHostEnv`. An inherited `PIDOCK_PROTECTED_PROFILE` is discarded; no task
  request can supply this authority. Missing or unverifiable context fails
  closed on production task operations, while unbound ping remains available.
- `protectApplicationProfile` captures the profile's real path and bigint
  device/inode. Every check revalidates the captured directory and original
  alias resolution. Replacement, movement, dangling links, access failures,
  non-absolute/NUL/overlong paths and raw `.`/`..` segments are denied with an
  error that does not contain the private path.
- Profile, descendants and ancestor sources are denied. Missing output paths
  resolve their deepest existing ancestor rather than falling back to a raw
  string prefix. Segment boundaries keep similarly named public siblings usable.
- Main task creation checks selected root, repositories and ordinary directories
  before creating an intent, before commit side effects, and before registering
  the completed task. Intent/source identities remain subject to the existing
  identity checks; nothing is rewritten to repair a rejected source.
- Host task creation and provisioning, checkout sources in provision/append
  plans, persisted ordinary source/link roots,
  file root enumeration, tree/preview/diff targets, and fixed-file service import
  scanning use the same policy. File roots check the task directory before
  reading its record. Direct controlled regular-file reads refuse multiply
  linked files conservatively, rather than trying to infer the other inode name.
- Legacy turn plans check both declared and returned targets, including read
  plans. A protected target at approval time is refused before authorization
  consumes its confirmation. It remains pending and can be explicitly rejected.
  `PiSessionChannel.runTurn.execute` is a **plan-producing test callback**, not a
  production filesystem executor. Approval records completion without replaying
  that callback. These checks are not real SDK tool execution acceptance.

## Verification

Command:

```sh
pnpm turbo run typecheck test build lint --force
```

Final log: `/tmp/pidock-gate-protected-profile-final3.log`.

- 8/8 tasks successful.
- Shell: 85 files; 1094 passed, 1 existing Windows-only skip.
- Renderer: 77 files; 609 passed.
- 14 added tests: 11 real-path/Host boundary cases, 2 main task-creation cases,
  and 1 trusted environment-context case.
- Normal previews and source attribution still work. Negative tests cover
  profile/ancestor/missing-descendant paths, sibling segment boundaries, profile
  replacement, dangling and changed aliases, linked private files, hardlinks,
  stale task records, raw dot-segment paths, rejection before record reads,
  source replacement between prepare and commit, and approval-time retargeting.

Real Electron utility-process verification:

```sh
pnpm --filter @pidock/shell exec electron scripts/electron-service-guard-smoke.mjs
pnpm --filter @pidock/shell smoke:async-checkpoint
```

Logs: `/tmp/pidock-profile-boundary-electron-final3.log` and
`/tmp/pidock-profile-async-regression-final3.log`.

- The real production main registry/Host still refuses service execution without
  creating an approval or changing lifecycle state. Ordinary import and file
  preview remain usable.
- A repository alias into profile is refused by file preview, with neither
  private path nor synthetic private body returned.
- Injecting a profile source into a persisted task record refuses roots and
  import scanning; restoring the safe record restores root access. The profile
  fixture body remains unchanged. These record writes are test setup only, not
  a supported metadata mutation API.
- A second actual utility process lacks the trusted main context despite a
  forged inherited variable. Ping succeeds and its task roots request is denied.
- The previous four actual native async-checkpoint scenarios pass: held terminal
  acknowledgement, cancel without a success report, Host SIGKILL recovery with
  zero relaunch, and lost starting acknowledgement with zero spawn/no late fix.

Optional test-inclusive typecheck:
`/tmp/pidock-profile-test-types-final3.log` still contains the 72 baseline
pre-existing diagnostics. There are no diagnostics in the new test. One old
`src/host/sdk-provider-context.test.ts` TS2554 message changes from "2-10" to
"2-11" accepted constructor arguments because the optional policy parameter was
added; its pre-existing 12-argument call remains invalid. Line/column normalized
comparison otherwise has no changes. This is not a passing optional typecheck.

## Failure History

- Initial typecheck lacked `app` in the runtime Electron import; fixed the import,
  without changing the authority source.
- `/tmp/pidock-profile-boundary-tests.log`: three test assumptions were wrong.
  Scanner deliberately returns a generic source error, initial source symlinks
  already fail main disk identity, and the planned approval target must be
  absolute. Fixed fixtures/assertions, not the success conditions.
- `/tmp/pidock-profile-boundary-tests-fixed.log`: the approval test incorrectly
  expected zero calls to a plan-producing callback. Confirmed the existing
  channel semantics, added the pre-authorization path check, and tested refusal
  without consuming approval or replaying the plan callback. No production
  execution claim is made from this test.
- `/tmp/pidock-profile-test-types.log`: a new test accessed private `write` state.
  Replaced it with the public `writeState()` readout; final diagnostics retain
  only the baseline failures described above.

## Limits And Remaining Work

This is a synchronous, use-time authorization snapshot, not directory-relative
atomic open authorization or an OS sandbox. Same-UID arbitrary shell/services
can still read or alter the profile. Copies, renamed single-link files, or other
inode provenance are not tracked. Git subprocess internals, custom transports,
hooks, executable behavior, and SDK tools not routed through this policy are not
constrained by it. Future production file/search tools must explicitly use this
policy and still need an atomic filesystem authorization contract where required.
Project source metadata can still be registered; it is refused when selected for
trusted task creation or consumed by the guarded task roots/tools. An ancestor
source is refused wholesale even if the requested child would otherwise be safe.

No Windows ACL, Junction/reparse-point race, installed artifact signature,
continuous cwd containment, or service lifecycle acceptance is established here.
Windows-specific symlink tests are skipped; no Windows machine result was
received. Production service control remains fail-closed. #7/#10/#47/#24 stay
open with no incomplete acceptance items checked. Still pending: trusted SDK
shutdown -> service drain -> durable report -> main disposal, bounded bootstrap
and lease revocation, stale-writer-lock recovery, durable presence markers for
whole-profile/journal deletion, and installed artifact/platform/business checks.
