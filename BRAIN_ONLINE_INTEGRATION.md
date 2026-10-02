# FACTORY → brain-online interface, v1

FACTORY owns backend orchestration, admission, budgets, recovery, model/provider
credentials and evidence. The brain-online chat
`01a0fed9-5f1a-70c1-a9da-b7354bfe89d2` owns its frontend and server-side adapter.
This contract is the first **staff/operator-only, read-only** view of one local
factory authority. Customer tenancy and remote command authority remain separate
work. Neither chat should edit the other's repository.

## Transport and identity

The presentation server binds to `127.0.0.1:4343` by default. Configure one explicit
factory ID and one existing controller database when starting it. Clients cannot
select database paths or impersonate tenants. The brain-online server supplies a
private bearer credential; its browser receives only the sanitized response.
There is no browser CORS or token-in-browser integration in this first slice.

`GET /v1/factories/factory-live-pilot/snapshot` returns:

```json
{
  "schemaVersion": 1,
  "factoryId": "factory-live-pilot",
  "observedAt": "2026-10-02T23:00:00.000Z",
  "scope": "local-coordinator",
  "revision": 42,
  "buildRevision": "<presentation build commit or unknown>",
  "cursor": "NDI",
  "capabilities": {"snapshot": true, "events": true, "commands": false},
  "snapshot": {
    "control": {"mission": "Improve FLUJO development speed", "epoch": 3, "status": "active"},
    "cells": [],
    "tasks": [],
    "effects": [],
    "budget": {
      "currency": "USD",
      "limitCents": 10000,
      "rootCommittedCents": 6000,
      "unallocatedCents": 4000,
      "meteredSpendCents": null,
      "basis": "logical-allocation"
    },
    "unresolvedEffects": 0,
    "effectsDrained": true,
    "workerQuiescence": "unverified"
  }
}
```

The snapshot and cursor come from one read transaction. `observedAt` reports the
read time; it is not the worker's last heartbeat. `revision` is the latest durable
event sequence and is nondecreasing. The opaque `cursor` bookmarks that sequence;
clients must preserve it without parsing it. Heartbeat timestamps can change without a new event; replace each
validated snapshot even when revision is equal. `buildRevision` identifies the
presentation implementation, not a worker's source revision. Empty arrays above
illustrate the shape and must never be used as a fallback for unavailable state.

Cells expose stable identity, parent identity, depth, role, status, heartbeat and
logical allocation. Tasks expose identity, project, branch, status, attempt,
owner, attempt, lease expiry, specification digest and candidate/review
hashes or verdicts. Effects expose stable key, kind, state, scope, owner/epochs,
request digest and timestamps. Tokens, token hashes, source filesystem paths,
artifact paths, raw specifications, response bodies and receipt payloads are
excluded. The implementation and tests define the exact DTO field names.

`GET /v1/snapshot` is an alias for this configured single factory, with the same
authentication and response identity. The browser adapter must still validate
the expected `factoryId`. Responses retain the `snapshot` envelope rather than
flattening controller tables into the transport object. The initial frontend
proposal's raw problem, acceptance, baseline and receipt fields are omitted.

Budget allocations include descendants through their parent: do not add every
cell's allocation to calculate global spending. `unallocatedCents` is admission
capacity, not cash remaining. Actual metered spend is currently unknown. The
owner's **US$100 total paid-cloud budget includes both Fly and Modal**, and overall
factory work has no time limit; resource and call limits belong to individual
experiments.

## Reconnect and events

`GET /v1/factories/factory-live-pilot/events?after=NDI` returns versioned JSON with
an ordered `events` array and a cursor for the next request. Each event exposes
only `seq`, `type`, `subject` and `observedAt`; raw event details stay private.
Start from the snapshot cursor. A client can reread events after reconnect without
dispatching work. A changed cursor can trigger another snapshot read. Snapshot
polling is sufficient for the first visual integration; no SSE assumption is
required.

401 means the bearer is missing or invalid. 404 means the configured factory or
route is unavailable. 503 means the real controller state could not be read. Show
an explicit disconnected/unavailable state in these cases. Writes return 405;
the current endpoint cannot spawn workers, run models, resume work or publish.

## Commands and evidence

Command support is currently false. A later command API will require a durable
command ID, exact request binding, actor/factory authorization, an expected
control epoch and a recorded acceptance/result. Browser retries must observe that
same command rather than applying it again. No UI button should imply this
capability exists before it is implemented and qualified.

Evidence hashes and verdicts can drive inspection. Downloading private artifacts
needs a separate authorization and redaction contract; clients must not translate
controller filesystem paths into public URLs.

## Run status

The read-only server is being implemented in `src/presentation.mjs` and
`bin/serve.mjs`. Root will record the verified launch command and live endpoint
here after the tests and actual server check pass. No running HTTP endpoint is
claimed by this initial contract.

The first Fly launch stopped during local fixture creation before any cloud
provisioning or model call. Its ledger is real; the cloud proof remains open.
The local Git crash/recovery proof passed. Modal inference work is separate and
shares the same total spending budget.
