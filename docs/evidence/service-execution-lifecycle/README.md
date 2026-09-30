# Service Execution Cancellation, Close and Recovery Experiment

Production `task/controlService`, `task/quit` and Host entry wiring are unchanged.
This is an isolated single-service lifecycle contract, not production service
execution, SDK cancellation integration, packaging or installation acceptance.

## Contract

`ExperimentalServiceExecution.close()` immediately seals new requests, waits
for the current operation/write claim to settle, then drains a live owned
supervisor session. Concurrent close calls share one report. It does not mint
an Agent confirmation: this is a trusted Host lifecycle method, not an exposed
human/Agent RPC. Unknown termination or a missing/failed recovery store refuses
a safe-close report. Failed close is cached without automatic reset or retry.

The bounded supervisor driver remains responsible for readiness/stop deadlines.
The controller awaits the injected approval persistence callback; it does not
pretend an arbitrary hung callback or driver has stopped. Production adapters
must supply bounded work and connect SDK shutdown before resource draining.

Cancellation applies to an in-flight control operation, not to an already
successfully started persistent service. Before execution, an aborted signal
causes zero launch/stop. Cancellation during confirmation persistence rejects a
pending minted confirmation, or burns one already approved, and persists that
invalidation. Spent approved requests cannot execute after a cancellation or
close observed after persistence. An abort during launch cleans the late ready
session with the original claim held; unknown cleanup remains owned and blocks
restart/close. Existing running services still require an explicit authorized
stop or trusted Host lifecycle close.

After awaiting approval persistence, stop rechecks current completion. A natural
confirmed exit is reported as exited without manufacturing a stopping record
with a null owner or dispatching another stop. Unknown completion refuses stop.
Cancellation is also rechecked after write-ahead saving, before the executor is
called; that never-spawned attempt can safely record stopped without pretending
a native terminal receipt existed.

## Checkpoints

A trusted synchronous recovery port reads/writes only:

```ts
{
  schemaVersion: 1,
  taskId,
  serviceId,
  state,
  ownerSessionId
}
```

Read validation enforces exact fields, task/service identity, valid states,
state/owner consistency and a 2048-byte bound. Null, malformed, foreign or
PID/path/config-bearing records refuse construction with a fixed error. Only
trusted `undefined` means no prior record. Credentials, launch arguments,
paths, PIDs, approvals and config values/fingerprints never enter the checkpoint.

Starting is acknowledged before spawn, then running and confirmed terminal
states are checkpointed. A write may have taken effect before throwing, so a
failed start checkpoint blocks launch and stays uncertain rather than inviting
blind retry. A failed running checkpoint cleans the live owned session but
never reports start success. Failed terminal saving retains uncertainty and
ownership, even when the process was observed stopped.

Reopening starting/running/stopping/unconfirmed normalizes to unconfirmed, with
no launch replay, PID adoption or PID-based stop. Clean stopped/exited records
also never auto-start; a new default-tier request needs a fresh confirmation.
Old-generation completion cannot overwrite a newer run's checkpoint.

`AgentOwnedResource.verificationRequired` is a trusted, opt-in uncertainty
fence. It blocks every new write claim, including by the original owner and for
human-owned resources, even if a live claim exists. It does not revoke ongoing
work or block reads. Existing known-owner/human behavior is unchanged unless
this flag is set. The experimental controller supplies the flag for unconfirmed
resources; production must wire a trusted resource source, never page claims.

The production recovery store and single-writer/Host-epoch authority are not
implemented. The injected store must be bounded, app-owned, tamper-resistant
against task tools, and acknowledge durability; the interface is not proof of
any of those properties. File wrappers used here are isolated test adapters,
not application storage. No recovery verification/reset operation is provided.

## Verification

```sh
pnpm --filter @pidock/shell exec vitest run src/host/service-execution-lifecycle.test.ts src/host/service-execution-experiment.test.ts src/host/write-coordination.test.ts
pnpm turbo run typecheck test build lint --force
pnpm --filter @pidock/shell smoke:supervisor
```

Twenty new lifecycle tests cover cancellation, approved/pending confirmation
invalidation, close barriers/idempotence, natural-exit/persistence interleaving,
write-ahead cancellation, failure acknowledgement, strict recovery validation,
no replay/adoption, generation isolation and real-disk reopen. An added shared
coordination test verifies owner/human/live-claim uncertainty fences and read
permission refusal; existing coordination tests keep their old behavior.

Final full gate: 8/8, shell 1041 passed / 1 Windows-only skipped, renderer 609
passed. A review-time typecheck caught stale static narrowing of mutable state
after an await; runtime revalidation now reads a fresh snapshot and the final
typecheck passes. No renderer/UI changes or new visual acceptance are claimed.

Actual Electron 44.4.3 / Node 24.21.0 utilityProcess smoke passed all original
six cases plus three lifecycle cases, using the real trusted catalog preparation,
development artifact, native supervisor and service fixture:

- Lifecycle close: seal/drain, confirmed stopped, cleared owner, stopped disk
  checkpoint, observed this run's helper/service/descendant gone before disposal.
- In-flight cancel: the actual service is ready while delivery to the controller
  is held; cancellation releases it for owned cleanup. The start reply is a
  cancellation, not success; native stopped and the safe close checkpoint agree.
- Host SIGKILL/reopen: disk still says running. Even after test observations show
  the old resources gone, a fresh utility/controller reports unconfirmed,
  attempts zero launches, exposes a verification-required resource, and refuses
  both start and safe close. It does not use observed PIDs as recovery authority.

Checkpoint and machine metadata, parent-port outputs and utility stdout/stderr
contain no synthetic private value. Test-only utility/known-PID cleanup is not
production quit authorization; the recovery fixture is explicitly disposed by
the harness after its failed-close assertion, without changing its checkpoint.
Test scripts remain outside Electron builder's production files and do not
load production Host RPC. Windows has no new real-runtime evidence.

## Remaining Gates

Production lifecycle integration, SDK/Agent cancellation mapping, recovery store
and writer lease authority, installed/signed artifact discovery, atomic verified
execution, Windows cwd/Job acceptance, human control, full business environment,
rolling logs and health UI remain outstanding. macOS detached descendants remain
outside the process-group contract. Issues #7/#10/#47/#24 stay open; no complete
acceptance box is checked and production execution stays fail-closed.
