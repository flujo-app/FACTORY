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

The read-only server was restored on `http://127.0.0.1:4344`, factory ID
`factory-live-pilot`, build `8f5a94048e9c8be007cf3b5229607783b49cd47f`.
The original port4343 service was observed unreachable and was not restored.
The actual check at 2026-10-03T04:34:51Z confirmed authenticated snapshot/Modal
reads200 and unauthenticated401, write405, query400 and other-factory404. An adapter
pinned to the old port/build needs a reviewed configuration update. This is a local process;
automatic restart and a remotely accessible service are separate work.

That check projected controller revision 91: `child-worker` and `parent-worker`
are retired, root logical unallocated capacity is 10,000 cents, and the root-owned
`launch-parent` task remains running. Paid revision 17 still has 10,000 held and zero
unallocated cents; final spend is null. The child allocation was nested inside the
parent's allocation, so root recovered 6,000 logical cents once. Source `8dce857`
qualified this closure with 288/288 checks and independent adoption audit. The
existing presentation process remains actual build `8f5a940`; it was not restarted
or relabeled. No DTO enums or browser commands were added, and workerQuiescence
remains unverified. HTTP witness SHA-256:
`1e545a0d0dca944e0daaae73d21486e4e00a92e0ba90b4bf5bd7be5644361bb4`.

The private bearer file is
`C:\Users\Moe\Documents\ChatGPT\FACTORY\.factory\viewer\credential.json`.
It contains `{ "token": "..." }` under owner-only Windows permissions. Load it
only into the server-side brain-online adapter; never expose it to its browser,
Git, logs or process arguments. FACTORY's `loadViewerToken` checks file ownership,
ACLs and file identity. No credential value appears in this contract.

For a new launch from the FACTORY directory, label the process with the checked-out
commit. The currently running process was launched earlier from `8f5a940`:

```powershell
$factoryBuild = (git rev-parse HEAD).Trim()
& 'C:/Users/Moe/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' bin/serve.mjs --database 'C:/Users/Moe/Documents/ChatGPT/FACTORY/.factory/federation-20261002/control.sqlite' --spending-ledger 'C:/Users/Moe/Documents/ChatGPT/FACTORY/.factory/spending.sqlite' --factory-id factory-live-pilot --token-file 'C:/Users/Moe/Documents/ChatGPT/FACTORY/.factory/viewer/credential.json' --modal-journals 'C:/Users/Moe/Documents/ChatGPT/FACTORY/.factory/viewer/modal-journals-20261003.private.json' --port 4344 --build-revision $factoryBuild
```

Shared paid reservations live separately in `.factory/spending.sqlite`: $10 Fly
and three $30 Modal reservations. All four are now `retired-meter-pending`; paid
revision 17 retains all $100, with $0 unallocated. Recorded observations round
conservatively to 24 cents (R1 4, R2 12, R3 8); every final charge field remains null
and final spend remains unknown. This is not exact total spend or a strict monetary
lower bound. R3's 8 cents conservatively rounds an owned-App US$0.07357657 observation
for the completed [01:00, 02:00) UTC hour, observed at 02:09:02.300 UTC. It does not
release the R3 hold or measure its entire experiment.
The current HTTP budget DTO reports controller
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

`knownMeteredCents` sums recorded observations in cents. These may be conservatively
rounded upward, so do not label the value exact spend or a strict monetary lower
bound. `meteredSpendCents` stays null while a started or retired-meter-pending
reservation has incomplete final
billing. `unallocatedCents` describes admission capacity. These figures cover
registered factory reservations, not an entire provider account. No App-specific
provider hard cap is implied. Missing configuration or unreadable paid state
produces `{availability: "not-configured" | "unavailable", scope, observedAt}`
without invented totals, while the readable controller snapshot remains usable.
The first visual PR may ignore this optional extension until its display contract
is independently qualified.

The recovered Fly pilot passed with two real workers and confirmed owned
retirement. The local Git crash/recovery proof also passed. Modal R3's original
prefetch reached its bridge bound at 02:29:27.667 UTC on October 3 and remains
unknown. Its original App stop and owned Volume deletion succeeded; an exact
provider witness at 02:30:48.157–02:31:11.303 UTC confirmed stopped/zero and App/Volume
absence. Its driver ended with exit 1, `requires-reconciliation`, and no inference.
Earlier rendered provider history records heartbeat
timeouts, a SIGKILL/137 with a memory warning, and replacement containers; its
fourth container was live at the historical 02:20 observation. Provider replacement does not
establish coordinator replay, a kernel OOM cause, complete weights or successful
inference. No Modal inference or native model/Flow execution has been proven yet.
The API's paused controller describes the Fly journal; it does not describe the
separate Modal operation journal. Both providers share the paid admission ledger.

A separate source-pinned FLUJO documentation task has now passed independent
review and local Git compare-and-swap delivery: candidate
`ea66f1130e01d3208173cd850d40f85f319b3582` from upstream `d6849271` changes only the
chat-completions README's HTTP versus authored Flow token-limit guidance. Its own
controller is paused at epoch 2 with zero unresolved effects. This separate task
is not exposed by the API's currently configured Fly controller. Local delivery
does not imply PR publication, upstream merge, runtime/model generation or a
development-speed benchmark. The presentation schema and command capability stay
unchanged.

The task's builder and reviewer cells were subsequently logically retired under
the qualified lifecycle subset. Independent audit confirmed the exact events,
preserved delivered-task evidence and unchanged paid records. This does not verify
process/provider quiescence. The initial lifecycle methods use existing DTO states;
The later narrow provider-bound Fly closure uses the same existing states.
Completed/cancelled task enums remain future work.

FACTORY source `0948fdd` now includes the reviewed lifecycle and low-memory HTTP
patches. Their 188/188 suite executed once in the isolated stage, and adoption was
verified against its source bytes. The HTTP path has not run in the cloud. This
source adoption did not restart the API or enable commands. A fresh authenticated
GET at 02:38:50 UTC confirmed API build `6fcd718`, schema 1, paused Fly revision 89,
`commands: false`, paid revision 17 and the recorded figures above, with billing
incomplete. Separate Modal and documentation execution journals remain outside
this configured endpoint. Protected witness SHA-256:
`783750aa183be89c5295f87e6db00e9ccfec8ee11eb102fd5080e268ef0a427b`.

The brain-online owner pushed build
`9b1daf9825d38b94b0a5da4ed3ba06b4d9feba4e`, adding the label “Controller admission”
and the actual observed backend build/revision and local-coordinator scope.
FACTORY inspected that narrow diff; the earlier independent 23-check execution
applies specifically to build `b811bbd`, not this later commit. The owner reports
28 checks plus typecheck/build passing and a fresh actual BFF read at 01:31 UTC.
The PR remains unmerged and undeployed by FACTORY.

## Separate Modal journal view

A separate owned local API initially ran on `http://127.0.0.1:4344`, implementation
build `67997585baa897bd7586fe21b9a755c89739a1a3`, preserving the old snapshot/events
contract. It was restored at build `8f5a940`, as reported above. No frontend adoption
of the new endpoint or automatic build-pin update is implied.

`GET /v1/factories/factory-live-pilot/modal-runs` (alias `/v1/modal-runs`) uses
the same private bearer mechanism. Its scope is
`registered-modal-operation-journals`, with
`capabilities: {"observation": true, "commands": false}`. It exposes `modalRuns`
and independently read `paidBudget`; it has no controller cursor or top-level
numeric revision. The original snapshot/events envelope is unchanged. Consult
[MODAL_OBSERVATION.md](MODAL_OBSERVATION.md) before adding a separate adapter.

Each journal's `journalRevision` is an unordered SHA-256 content fingerprint.
`basis: "persisted-local-operation-journal"` and
`providerFreshness: "not_observed"` explicitly distinguish a record read from
a new provider observation. Private request bindings are verified internally;
request JSON, raw response text, credentials, endpoints, profile/workspace names,
file paths, and private reconciliation proofs are excluded. A bad journal is
unavailable individually. Controller unavailability does not prevent this route
from returning healthy registered journals and the separately qualified budget.

The actual authenticated check at **03:05:45.936–03:05:46.130 UTC, October 3**
returned three registered runs and all 15 recorded operations. Every prefetch
remains unknown; recorded App stops and Volume deletions remain separate historical
outcomes. Authenticated alias/scoped reads and the existing snapshot returned 200;
unauthenticated reads returned 401, writes 405, client path queries 400, and a
different factory 404. Journal and spending state, including main/WAL bytes,
stayed unchanged. No provider call or paid dispatch occurred. Paid revision 17
retains all 10,000 cents, zero unallocated, 24 conservatively rounded partial
cents, null final spend, and incomplete billing.

The exact combination passed 270/270 full-suite results with exit 0, no skips or
cancellations, and unchanged source. A first evidence recorder failed after its
270 passing text-format results because it expected TAP; that output was preserved
and one corrected qualification run recorded exit/source identity. This is a new
combination's qualification, separate from the earlier isolated 188 result.
Protected actual API witness SHA-256:
`d73219e9fe4ee2566c2799f5f6856dec2986dced67fdbfe3a65cf53d0b22acb1`.
Model inference, native FLUJO Flow execution, final billing, and budget release
remain unproven.
