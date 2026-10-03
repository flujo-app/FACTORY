# Durable advisory peer messages

Two configured factory/cell identities can exchange authenticated messages using
an independent SQLite ledger. This implements the message retry contract proposed
in FEDERATION.md. It does not enroll workers, grant leases, dispatch a model,
allocate capacity, pause admission or publish a candidate. Peer payloads remain
advisory data; their task/epoch/policy provenance grants no controller authority.

Each pair receives a random 256-bit HMAC key and an explicit credential generation
and expiry. Both identities, request method/path, generation, canonical body hash
and original message digest are authenticated. HMAC proves possession of the pair
key, not nonrepudiation between its two holders. Only an active generation can
authenticate a new request or replay. The store retains its generation floor;
same-generation key changes and stale configuration are rejected. An explicit
local rotation uses a compare-and-swap of the previous generation.

The sender commits the exact envelope and destination before HTTP. The receiver
commits one inbox record and one event before returning a canonical authenticated
acknowledgement. Lost, malformed, oversized, wrong-identity or unauthenticated
responses leave the original outbox pending. Retry uses that original body and
fixed endpoint; no redirect is followed and a configuration change cannot silently
move an uncertain delivery. Endpoint rebinding is deliberately unsupported.

A committed exact duplicate can be acknowledged after its message expiry under
active authentication. An unseen expired message is rejected. A changed envelope
cannot reuse its message ID. Acknowledgement resolution authenticates the full
tuple again inside the sender transaction. The inbox and events support bounded
pages; trusted consumers can call `readInbox(messageId)` to retrieve advisory data.

Plain HTTP accepts only literal loopback addresses (`127.0.0.1` or `::1`). Remote
endpoints require HTTPS with normal certificate validation. The server binds to
loopback by default; a non-loopback listener requires explicit HTTPS credentials.
Envelopes are limited to 64 KiB, acknowledgements to 2 KiB, nesting to 16, and one
send attempt to at most 30 seconds (5 seconds by default). The wire must be exact
canonical UTF-8 JSON with closed envelope and acknowledgement fields. Response
errors and CLI output omit credentials and raw payloads.

The ledger uses a distinctive SQLite application ID and validates existing state
read-only before opening it for writes. It refuses unrelated controller/spending
databases. Application-process recovery uses SQLite FULL synchronous WAL; this
does not establish storage hardware or power-loss guarantees. There is one local
authority for each advisory store, not cross-host consensus or independently
hosted high availability.

## Explicit CLI

Use Node 24 or newer. This machine's default Node is older; the bundled executable
is `C:/Users/Moe/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe`.
All operations require `--private-module ABSOLUTE_PATH`, selecting the trusted
private-files helper. The existing helper is
`C:/Users/Moe/Documents/GitHub/flujo-cloud/lib/private-files.mjs`. It checks owner-only
Windows ACLs and file identity. Configuration must be owner-private. Select a new
dedicated private data directory and an explicit peer database; existing shared
directories are not reprotected. Keep config files, databases and TLS private key
material out of Git and public logs.

`node bin/peer.mjs pair --private-module HELPER` reads one JSON object from stdin:

```json
{
  "a": {"identity": {"factoryId": "factory-a", "cellId": "coordinator"}, "endpoint": "http://127.0.0.1:4351/v1/peer/messages"},
  "b": {"identity": {"factoryId": "factory-b", "cellId": "watcher"}, "endpoint": "http://127.0.0.1:4352/v1/peer/messages"},
  "generation": 1,
  "credentialExpiresAt": 1800000000000,
  "bootstrapPath": "ABSOLUTE_NEW_PRIVATE_BOOTSTRAP_PATH",
  "configAPath": "ABSOLUTE_NEW_PRIVATE_CONFIG_A_PATH",
  "configBPath": "ABSOLUTE_NEW_PRIVATE_CONFIG_B_PATH"
}
```

Paths and expiry must be selected explicitly. Pair configuration creation is
exclusive and never overwrites an existing key. The selected owner-private bootstrap
intent retains both exact configurations before either is published. If publication
fails or the process stops, repeat the exact request with the same bootstrap path:
matching files are reconciled, only missing files are published, and the original
key/generation survive. A mismatch fails closed and retains the original intent.

Other commands use `--config ABSOLUTE_CONFIG --database ABSOLUTE_PEER_DATABASE`
and the same `--private-module`:

- `serve --port 4351` listens on loopback; `--host` and `--tls-file` select an
  explicit HTTPS listener. The private TLS JSON file contains only `key` and `cert`
  PEM strings. Serve B on its selected port with configuration B.
- `enqueue` reads `{messageId,type,payload,expiresAt}` from stdin. Types are
  `health_observation`, `checkpoint`, `review_result`, `work_offer`,
  `recovery_request` and `capacity_request`; all are advisory. Optional `createdAt`
  and closed `provenance` fields preserve audit context.
- `send --message-id ID` attempts the already persisted outbox once. A pending
  result is uncertainty; retry that ID, preserving the same ledger and configuration.
- `inbox` lists metadata without printing payloads; `status` prints ledger counts.
- `read --message-id ID --output ABSOLUTE_NEW_PRIVATE_FILE` exports one validated
  advisory envelope to an exclusive owner-private file, without printing its data.
- `rotate --expected-generation N` adopts an explicitly prepared private config
  with generation N+1 and a new key. Rotate both sides; stale live instances reject
  authentication until reopened with the new config. Identity and endpoint stay fixed.

No existing presentation route or command capability changes. Local two-process
qualification demonstrates protocol crash/retry behavior; an independently hosted
peer and full FLUJO autonomous federation still need separate acceptance.

## Automatic mutual watching

`watch --watch-file ABSOLUTE_PRIVATE_JSON --port PORT` owns a peer receiver and
automatically probes the configured other peer. Start one process for each side,
using the existing private pair configs and separate advisory databases. A watch
profile is closed and explicit:

```json
{
  "schemaVersion": 1,
  "watchId": "alpha-watches-beta",
  "source": {
    "snapshotUrl": "http://127.0.0.1:4361/v1/snapshot",
    "tokenFile": "ABSOLUTE_PRIVATE_VIEWER_TOKEN_JSON",
    "expectedFactoryId": "factory-a",
    "expectedCellId": "coordinator"
  },
  "intervalMs": 2000,
  "timeoutMs": 5000,
  "maxAgeMs": 30000,
  "messageTtlMs": 60000,
  "durationMs": null
}
```

The source identifies this process's own factory/cell and accepts only a fixed
literal-loopback HTTP snapshot GET. Its private JSON token file contains exactly
`{"token":"RANDOM_VIEWER_TOKEN"}`. The token is used only for that local source;
no viewer token, private path or source URL travels to a peer. `durationMs:null`
runs until an explicit stop or credential failure. A positive duration may bound
a temporary rehearsal. Polling is 1–60 seconds, each HTTP attempt 0.1–30 seconds,
source age 1 second–1 hour, and message expiry 1 second–24 hours.

Watch receivers additionally expose fixed `GET /v1/peer/health`. This is a separate
HMAC domain from messages, binding both identities, credential generation, GET
method, exact path, random challenge nonce, request time and canonical response
bytes. Request and response freshness have a 30-second clock-skew bound; health
bodies are limited to 8 KiB. Authentication is checked before and after source or
peer IO and inside the observation transaction. No redirects are followed. A
plain `serve` receiver does not expose health without an explicit source reader.

The authenticated response reports its process instance and a closed projection
of its own read-only snapshot: controller revision/status/epoch, configured cell
role/status/heartbeat classification, unresolved effect count/drain status,
`workerQuiescence:"unverified"`, logical allocation aggregates and USD paid
aggregates/revision. Paid overcommit is retained, incomplete billing keeps final
spend null, and paid availability is separate from controller availability. Raw
missions, tasks, effects, reservations, commands and credentials are omitted.
An unavailable local source still permits an authenticated health response; that
response does not assert fresh controller or budget capacity.

Each watcher persists meaningful changes as advisory `health_observation`
messages. Poll times, nonce, mailbox counts and raw age do not create changes.
Status, reachability/authentication, freshness classification, revisions, actual
aggregate changes and remote process restart can create an episode. Independent
controller and paid revision floors survive outages and restarts. A rewind marks
the current source unavailable and keeps the prior trusted projection separately;
it cannot turn stale history into recovered capacity.

The retained watch-owned outbox chain is also the durable checkpoint. One existing
SQLite transaction compares its predecessor and admits the exact message and
event. Competing watchers discard stale probes and reobserve. There are no new
tables or peer schema/config versions. The full retained chain is validated in
bounded pages, with no lifetime observation cutoff. Explicit stable `watchId` and
immutable nonsecret config-binding digest prevent silent source/policy repointing;
configuration migration is unsupported. Pair credential rotation preserves the
watch namespace and original pending bodies.

On restart, watchers reconcile their own pending intents automatically. Retries
retain original message ID/body/digest, destination, created time and expiry;
they never enqueue a refreshed replacement. Uncertain expired originals remain
explicitly `expired-unconfirmed`; already committed duplicates can still resolve
their original acknowledgement. Retry backoff is capped at 30 seconds. At 32
pending intents admission pauses while retries continue, so newer observations
are rechecked when capacity frees. Later eligible intents do not wait behind an
expired original. stdout exposes listening, changed observation, delivery and
backpressure/stopped states; it suppresses unchanged observations.

This grants observation and advisory delivery only. It cannot claim a task,
change controller state, release billing holds or admit paid work. Qualification
must show two actual processes observing each other, unchanged-state silence,
receiver/watcher restart and exact original ACK recovery. Same-host qualification
does not establish independent-host availability or deployed FLUJO autonomy.
