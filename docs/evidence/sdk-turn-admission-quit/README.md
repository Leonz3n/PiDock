# Installed SDK Turn Admission And Active Quit

Later [active model/report fault evidence](../active-model-report-faults/README.md)
joins real model turns to experimental service drain/report/native release,
including abnormal SDK termination and actual turn-directory permission failure.
Installed combined service/report/release adapters remain missing.

Follow-up to [main release/native exit](../host-release-native-exit/README.md),
for [issue #7](https://github.com/Leonz3n/PiDock/issues/7). This slice changes the
installed Host's existing SDK quit path without enabling service execution,
experimental recovery/report wiring or renderer tools.

## Changes And Failure Boundaries

`task/quit` already synchronously rejects new SDK RPC via `sdkClosing`. It now
also seals the current `SdkTurnTransport` before SDK shutdown. Transport `start`
checks sealing before any journal access and again after awaited `kernel.open`.
A request admitted to pre-acceptance opening before quit cannot subsequently
publish an accepted journal or invoke prompt after the seal. Shutdown settlement
waits for pending opening as well as accepted active runs; the existing 15s Host
settlement deadline and cached quit receipt remain authoritative. An opening
that finishes after timeout is refused, not a repaired shutdown receipt.

Journal acceptance publication failure now permanently fences that transport's
future starts and `assertTerminalCommitted`/shutdown settlement. In particular,
a readable accepted record after directory fsync failure cannot make shutdown
appear clean merely because no model prompt ran. Restoring the fsync adapter or
reading the record does not clear uncertainty. There is no accepted-record reset,
backup restoration, replay or migration. This is a live-instance fence, not a new
SDK journal inventory, authenticated cold-recovery scheme or deletion witness.
Existing exact known terminal reconciliation remains unchanged.

Prompt work is registered as active before execution begins. A synchronous
kernel prompt exception therefore publishes its failed terminal record and
removes the same active run; it cannot leave a phantom active map entry forever.
This does not hide terminal journal failure or grant service release authority.

## Verification

```sh
pnpm turbo run typecheck test build lint --force
pnpm --filter @pidock/shell smoke:active-turn-quit
pnpm --filter @pidock/shell smoke:host-release
pnpm --filter @pidock/shell smoke:shutdown-report
pnpm --filter @pidock/shell exec node scripts/sdk-shutdown-test.mjs
pnpm --filter @pidock/shell exec node scripts/sdk-context-isolation-test.mjs
```

Full gate `/tmp/pidock-turn-seal-gate.log`: 8/8; shell 90 files, 1170 passed /
1 existing Windows-only skip; renderer 77 files, 609 passed. Six new tests cover
pending-open seal/settlement, sticky acceptance fsync uncertainty, synchronous
prompt throw, new/idempotent starts after sealing, active terminal settlement
and late open after bounded close failure. Focused transport/kernel/provider
suite: 40/40 in `/tmp/pidock-turn-seal-focused.log`.

Separate red reproductions preceded each fix:
`/tmp/pidock-turn-seal-red.log`, `/tmp/pidock-turn-acceptance-red.log`,
`/tmp/pidock-turn-sync-prompt-red.log`. Optional test-inclusive tsc remains red
with the same 72 baseline diagnostics, byte-identical to the preceding slice's
`/tmp/pidock-release-test-types-final2.log`; current log:
`/tmp/pidock-turn-seal-test-types.log`. This optional gate is not reported passed.

Actual Electron 44.4.3 / Node 24.21.0 on macOS arm64:
main `PerTaskHostRegistry`/`HostClient` -> compiled production
`host-entry.js` utility -> real isolated SDK worker -> real SDK AgentSession ->
loopback OpenAI-compatible SSE Provider. The development main probe supplies a
trusted shell-origin caller directly; it does not drive renderer IPC/UI or prove
installed signed packaging. Provider sees exactly one request per scenario,
matching model and explicit credential; request tools are observed empty.

- `active-stream`: after a real model request and streamed delta, explicit quit
  aborts the open stream. The request journal is durable `cancelled`, with the
  same turn ID as acceptance; SDK JSONL retains the input.
- `before-first-delta`: real Provider headers arrive but no content frame is sent.
  Explicit quit still aborts and durably records `cancelled`, without waiting for
  a token or silently completing the request.
- `provider-disconnect`: the Provider drops the stream after partial content.
  The SDK turn durably remains `failed`; later explicit quit drains SDK state
  without converting the failed turn to success or repeating the request.

Every scenario verifies identical repeated quit receipts, empty lifecycle
failure/retained lists for this SDK-only task, rejected late prompt and Provider
reinstallation, no second request journal/model call, observed Provider stream
close and no synthetic credential in turn journal/SDK JSONL/events/Host output.
Log: `/tmp/pidock-turn-seal-electron-final.log`, `ACTIVE_TURN_QUIT_OK`.
Pending-open and fsync failure injection are deterministic unit evidence, not
actual filesystem/installed bootstrap fault injection. Native utility kill is
explicit fixture cleanup after quit, not a cooperative installed release proof.

Regressions passed: `/tmp/pidock-turn-seal-release-regression.log` (three actual
release scenes), `/tmp/pidock-turn-seal-report-regression.log` (four report scenes),
`/tmp/pidock-turn-seal-worker-regression.log` (three real Worker transport shutdown
faults), `/tmp/pidock-turn-seal-isolation-regression.log` (real SDK worker/loopback
credential isolation/redaction). Worker transport fault substitutes are not
active-model failure evidence; the new active-model scenes above use the real SDK.

## Remaining Work

No production service start/stop, complete owned-service/tool inventory, all-tool
sealing or installed experimental lease/report/release wiring is enabled. Real
active-model force-termination/report-ack races and terminal storage faults,
trusted stale-lock repair, reservation retention/migration, signed artifact atomic
execution, Windows ACL/cwd/Job, business environment/log/health and UI/manual
acceptance remain. This does not merge SDK journal and service recovery authority.

Independent subagent review remains blocked by the previously recorded installed
host/core `./node` export incompatibility; no independent approval or alternate
CLI fallback is claimed. #7/#10/#47/#24 stay open, incomplete acceptance boxes
untouched. The unrelated untracked research document is unchanged and unstaged.
