# UtilityProcess Supervisor Experiment Evidence

Platform: macOS arm64. Actual utility runtime: Electron 44.4.3, Node 24.21.0.
This is an isolated experiment, not production Host/RPC or installed-package acceptance.

## Commands

```sh
pnpm --filter @pidock/shell build
pnpm --filter @pidock/shell build:supervisor:mac
pnpm --filter @pidock/shell smoke:supervisor
pnpm turbo run typecheck test build lint --force
go -C packages/shell/native/service-supervisor test -race -count=1 ./...
GOOS=windows GOARCH=amd64 go -C packages/shell/native/service-supervisor test -c -o /tmp/pidock-utility-supervisor-windows.test.exe
```

The Electron run emitted `SUPERVISOR_UTILITY_SMOKE_OK` for all six scenarios.
The main process created an isolated task/project/catalog, inspected a development
artifact, prepared the pinned private request, and transferred it in memory to
an explicit test-only utilityProcess entry. An explicit Go fixture (not a shell
command chain) created the service descendant and printed synthetic environment
output. Each scenario used a fresh utility Host and service binding.

| Scenario | Terminal Receipt | Observed Helper, Service, Descendant Gone | Utility Exited | Private Value Visible |
| --- | --- | --- | --- | --- |
| Stop | stopped | yes | yes | no |
| Control input disconnect | stopped | yes | yes | no |
| Host self-exit | none | yes | yes | no |
| Host SIGKILL | none | yes | yes | no |
| Supervisor SIGKILL | unconfirmed | yes | yes | no |
| Service parent exit | exit, code 3 | yes | yes | no |

Each run checked outbound parent-port messages, captured utility stdout/stderr,
and machine-private catalog metadata for absence of the synthetic value. Logs
contained the redaction marker before control/termination was exercised.
Only exact observed PIDs from this run were checked; emergency PID cleanup is
strictly a test fallback, not a production resource ownership design.

Complete gate: 8/8 successful; shell 1007 passed, 1 Windows-only skipped;
renderer 609 passed. Native macOS race tests and Windows test compilation passed.
Windows tests were not executed. There is no UI change or screenshot acceptance.

## Boundaries

- Test-only scripts are outside packaged files; production host-entry and
  task/controlService remain unchanged and execution-unavailable.
- Host death has no terminal receipt. Supervisor death stays unconfirmed even
  when this test observes resource disappearance; no recovery state is forged.
- Supported macOS descendants remain in the anchor's process group. Deliberate
  session/group escape, external executable replacement and arbitrary process
  ownership are not covered by this evidence.
- This does not prove Windows cwd identity/Job Object behavior, signing,
  installed-package binary discovery, health checks, permission integration,
  normal product shutdown, or real business repository execution.
- The first smoke attempt refused a chained shell fixture during template
  validation, before launching a service. The final native fixture preserves
  that validation rule rather than bypassing it.
