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

The read-only server is running at `http://127.0.0.1:4343`, factory ID
`factory-live-pilot`, build `6fcd718592ebf86b2d546f0eaab2cb5b159a4140`.
The live check at 2026-10-02T23:21:24Z confirmed unauthenticated 401,
authenticated snapshot/events 200, and write 405. This is a local process;
automatic restart and a remotely accessible service are separate work.

The private bearer file is
`C:\Users\Moe\Documents\ChatGPT\FACTORY\.factory\viewer\credential.json`.
It contains `{ "token": "..." }` under owner-only Windows permissions. Load it
only into the server-side brain-online adapter; never expose it to its browser,
Git, logs or process arguments. FACTORY's `loadViewerToken` checks file ownership,
ACLs and file identity. No credential value appears in this contract.

The verified launch command from the FACTORY directory is:

```powershell
& 'C:/Users/Moe/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' bin/serve.mjs --database 'C:/Users/Moe/Documents/ChatGPT/FACTORY/.factory/federation-20261002/control.sqlite' --spending-ledger 'C:/Users/Moe/Documents/ChatGPT/FACTORY/.factory/spending.sqlite' --factory-id factory-live-pilot --token-file 'C:/Users/Moe/Documents/ChatGPT/FACTORY/.factory/viewer/credential.json' --port 4343 --build-revision 6fcd718592ebf86b2d546f0eaab2cb5b159a4140
```

Shared paid reservations live separately in `.factory/spending.sqlite`: $10 Fly
and $30 Modal, with $60 unallocated. The current HTTP budget DTO reports controller
logical allocation only. The optional `snapshot.paidBudget` extension reads the
separate paid ledger when the server starts with `--spending-ledger ABSOLUTE_PATH`.
It has its own read transaction, `revision` and `observedAt`; paid writes do not
change the controller cursor. Refresh it even when the controller revision stays
the same. No actual provider charges are inferred from reservations.

The available paid DTO exposes `availability: "available"`, `schemaVersion: 1`,
`scope: "registered-factory-paid-reservations"`,
`basis: "shared-paid-admission-ledger"`, `currency: "USD"`, `limitCents`,
`committedCents`, `unallocatedCents`, `overCommittedCents`, `knownMeteredCents`,
`meteredSpendCents`, `billingIncomplete`, `revision`, `observedAt`, and
`reservations`. Each reservation exposes `reservationId`, `provider`, `state`,
`ceilingCents`, `heldCents`, `chargedCents`, `finalCents`, `overCeilingCents`, and
ISO/null `createdAt`, `startedAt`, `retiredAt`, `settledAt`, `cancelledAt`,
`observedAt`. No digests, raw invoices, account identifiers or paths are exposed.

`knownMeteredCents` is a lower bound from recorded observations;
`meteredSpendCents` stays null while a started reservation has incomplete final
billing. `unallocatedCents` describes admission capacity. These figures cover
registered factory reservations, not an entire provider account. No App-specific
provider hard cap is implied. Missing configuration or unreadable paid state
produces `{availability: "not-configured" | "unavailable", scope, observedAt}`
without invented totals, while the readable controller snapshot remains usable.
The first visual PR may ignore this optional extension until its display contract
is independently qualified.

The first Fly launch stopped during local fixture creation before any cloud
provisioning or model call. Its ledger is real; the cloud proof remains open.
The local Git crash/recovery proof passed. Modal inference work is separate and
shares the same total spending budget.
