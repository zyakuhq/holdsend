# Independent source review of 0.1.0 (2026-10-27)

An outside reviewer read the source of 0.1.0 (core, server, web and React Native) without running the tests. They found no exploitable vulnerability and raised six risks (HS-001 to HS-006). Their verdict was to keep the design, fix the boundaries, and not call it ready for production; we agree.

Each finding was checked against the code. A finding we could reproduce got a test that fails without its fix.

| ID | Finding | Our verdict | Fix (0.1.1) |
| --- | --- | --- | --- |
| HS-001 | `purgeExpired()` deletes stale `in_progress` claims, possibly while their request is still running | The code was already safe: completion checks the claim token inside the same transaction as the write, so a request whose claim was removed rolls back with `ClaimLostError`. This case had no test. | A real Postgres test: a slow request, a purge, a retry that commits, and then the slow request fails to commit. Exactly one post remains, and a replay answers with the retry's result. Checked to fail when the token check is removed. |
| HS-002 | React Native updates take turns through an in-memory map, which does not coordinate separate runtimes | Correct, and not documented. | The README says updates take turns within one JavaScript runtime only, and that no other runtime may write the same key. A native background sender is on the roadmap and will need its own lock. |
| HS-003 | With `completedTtlMs` set, a record can expire before a late retry, which then creates a second copy | Correct. The default keeps records forever, but the risk was not documented. | "What exactly once depends on" in the server README explains it, including that items older than `confirmAfterMs` are still sent with the same key after approval. |
| HS-004 | `requireKey` defaults to `false`, so a request without a key runs unprotected | Correct. The examples set it to `true`, but the rule was not stated. | The same section states the rule. Changing the default would break existing clients, so it waits for a minor version. |
| HS-005 | Try again after `key_conflict` uses a new key and may create a second resource | Already documented, by design. `retry()` returns `newKey: true` so the app can ask the person first. | None. |
| HS-006 | `add()` stores the caller's payload object, so a custom store that keeps references would send later edits | The built-in stores copy, but the `Store` contract did not require it. Reproduced with a store that keeps references. | `add()` keeps its own copy of the payload and returns a copy of the item. The `Store` contract says stores must keep their own copies. Test checked to fail on the old code. |

## Also found while preparing 0.1.1

- On Node 20 releases before 20.19, `require()` of the packages fails with `ERR_REQUIRE_ESM`, while `import` works. The READMEs now say so, and a CI job runs the built packages on Node 20.0.0 (`scripts/smoke-node.mjs`). The job was checked to fail on a server that ignores the key.

## Still open

The reviewer's list of further tests includes several we already run: thousands of random histories with lost answers, crashes and two senders in the fault-injection suite; 60 concurrent copies of one request on a real Postgres server; several browser tabs; corrupt stored data. These are still open:

- React Native background and foreground races on a real device.
- Browser storage eviction.
- Very large payloads on a slow network.
- Request size limits on the server.

All four are on the roadmap.
