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
