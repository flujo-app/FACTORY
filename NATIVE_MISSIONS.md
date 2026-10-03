# Assigned native missions

A trusted local dispatcher can assign a software task to a provision-bound child
and execute its selected native Flow. A task's immutable `nativeMission` contains
`schemaVersion: 1`, a fresh 32-character hexadecimal `missionId`, `cellId`, `app`,
`provisionKey`, `worker`, `flowId`, canonical `flowSha256` and
`paid: { provider, ceilingCents }`. The positive paid ceiling reserves an allowance
in the actual SpendingLedger; it is not a physical provider spending limit.

`worker` is exactly `{ workspace, archiveSha256, compatibility }`. Compatibility
contains `applicationVersion`, `snapshotFormatVersion`, `layoutVersion` and
`workerProtocolVersion`, plus its own optional `revision` when advertised by the
worker. A revision is exactly 40 lower-case hexadecimal characters. Both the
mission contract and authenticated native client retain it in the exact
compatibility tuple; omitting or changing an advertised revision cannot claim,
dispatch or recover the assignment. Use the child's actual restored snapshot identity;
the parent's archive identity is not interchangeable. The controller requires
the original successful provisioning effect and permanent app/cell bindings.

Authenticated preparation checks native readiness, snapshot compatibility,
the current Flow hash and unique name routing, and absence of the fresh mission
conversation. Enrollment and task claim commit together. The mission packet
contains the task/spec/attempt, branch, baseline, problem and acceptance criteria.
The selected Flow receives that packet as its original user message.

The controller records one lifetime effect key for the immutable task. Changing
an output filename or claiming another lease cannot obtain another POST. Paid
admission and the controller writer fence surround the actual POST invocation,
after all asynchronous preparation. Existing intents are never dispatched again.
An uncertain result remains `unknown`; authenticated conversation observation
can recover the original completed result after restart. Missing, interrupted,
failed or incomplete conversations cannot authorize a retry. Native observation
may repair FLUJO recovery metadata, but it does not run or resume the Flow.

The Flow hash is verified before dispatch. FLUJO's conversation response does
not attest an executed graph hash; concurrent external graph edits remain outside
this proof. Keep the assigned worker workspace under its existing ownership rules.
Raw conversation results go into a strict owner-private JSON artifact. A successful
execution effect leaves the software task running, with review and delivery still
required. It does not prove autonomous planning, recursive cloud deployment or
accepted software delivery.

Run `bin/mission.mjs claim|run|observe --private-module ABS --profile PRIVATE_JSON`.
The existing controller and paid databases must be in protected private directories.
The native origin is explicit HTTPS or literal loopback HTTP, including an owned
cloud tunnel. Credentials are read from `tokenFile`, containing exactly `{ token }`.
The imported private helper provides the existing owner-private JSON operations.

| Command | Exact private profile fields |
| --- | --- |
| All | `controlDatabase`, `client` |
| `claim` | `taskId`, `outputFile`, `leaseFile`, `ttlMs` |
| `run` | `spendingDatabase`, `leaseFile`, `outputFile` |
| `observe` | `key` |

`client` contains exactly `origin`, `tokenFile`, `worker` and `timeoutMs`. A claim
writes the private task lease to a fresh destination. If interruption occurs
between task claim and that file write, the trusted operator can release the
unstarted assignment using the existing task release contract; no Flow has run.
Observe uses the permanent effect key and the recorded original output destination.
Provider retirement and complete billing settlement remain separate operations.

`scripts/native-mission-smoke.mjs` accepts explicit pinned `--application`,
`--expected-head`, fresh private `--evidence` and `--private-module` paths. It
restores a fresh encrypted native child, loses its completed POST response,
restarts controller and worker, recovers through native conversation observation,
and checks paid refusal. Its model and provisioning record are fixtures.
