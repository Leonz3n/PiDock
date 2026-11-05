# Synthetic Pi session fixtures (reconstructed)

**These are NOT real user sessions.** They contain no data copied from
`~/.pi/agent`. Every line was reconstructed from the published package formats
and the pinned SDK docs so that the on-disk shape matches the version named in
the file name.

| Fixture | Reconstructed as | Lines | Bytes | sha256 |
| --- | --- | --- | --- | --- |
| `pi-0.87.1-session.jsonl` | Pi `0.87.1` session v3 | 14 | 4641 | `d69ec41c6e0577ec70737b48d168b517f31fa8ef8854d68c2a75a20487f5ddc5` |
| `pi-1.4.0-session.jsonl` | Pi `1.4.0` session v3 | 12 | 4682 | `d57367667018bd12243e2fc13a406f219d23fccd35714ba6a42aba868f074346` |

Provenance:

- Exact published tarballs were downloaded for format comparison:
  - `@earendil-works/pi-coding-agent@0.87.1`
    sha256 `1423ee3c61e7c96464e1cbf3c8dc24d3056cb3410995c3671a98c3ecc527540f`
  - `@earendil-works/pi-coding-agent@1.4.0`
    sha256 `d155c16ef6fa00960fbf58b2911536e80b05f33700e0b14fbd08967ede0c7428`
- Header, message entries, usage/cost fields, compaction entries and tool-call
  shapes follow those packages' `SessionManager`/`session-format` docs.
- The 0.87.1 fixture deliberately carries the then-documented
  `system.replace` field (removed by 1.4.0), plus unknown future fields
  (`future_extension_state`, `futureVendorField`).
- The 1.4.0 fixture carries `thinkingLevel`, `nestedCalls`, the virtual-model
  custom entry `pi.virtual-model-state`, and unknown fields
  (`futureVendorField` in the header, `futureMessageField` in messages).
- `cwd` uses the literal placeholder `__PIDOCK_TASK_DIR__` in the checked-in
  fixture. The evidence script substitutes the real temporary task dir **only
  on a working copy**; the checked-in file is never modified.

Why the unknown fields: they make the compatibility test able to distinguish
"tolerates and preserves" from "silently rewrites". The test asserts the bytes
of the checked-in fixture stay unchanged and that the working copy keeps those
fields after a 1.5.0 open + append.

Regenerate / inspect:

```sh
sha256sum docs/evidence/pencil-v1-t19-upgrade/fixtures/*.jsonl
node packages/shell/scripts/pencil-v1-t19-upgrade-session-evidence.mjs
```
