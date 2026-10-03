# Native FLUJO capacity requests

A native Flow can call `factory_capacity_request` through a private Streamable
HTTP MCP endpoint. Its arguments are a stable `requestId`, allowed `role`,
positive `budgetCents` and bounded `purpose`. The server supplies the grant and
authenticated peer destination. The reply confirms transport receipt; the
recipient broker separately decides admission and provisioning.

Only a trusted local operator can issue a standing grant. It binds the exact
task lease, specification digest, attempt and controller epoch; peer pair,
credential generation and an inbox sequence floor; allowed roles, lifetime,
total child count and logical allocation; immutable image digest, source
workspace, selected Flows, organization and region; and a positive paid ceiling
per request. For a native tool it also binds the worker's assigned workspace,
encrypted snapshot hash and compatibility metadata. Historical advisory messages
cannot acquire this grant retroactively. PeerStore remains an advisory transport.

One controller transaction reserves the child, debits the grant quota and admits
the unique provisioning effect. The broker then reserves and starts an allowance
in the actual local SpendingLedger, rechecks authority and invokes the existing
ManagedCloud adapter. It performs no provider preflight before paid admission.
Every admitted request retains its original allocation, target and intent;
replay observes that intent and never launches it again. A definite refusal
before dispatch records `not_applied`; an uncertain dispatched result records
`unknown`. Neither automatically releases paid holds or proves worker quiescence.

`bin/capacity.mjs` accepts `issue`, `tool` and `broker`, each with an explicit
`--private-module ABSOLUTE_PATH --profile PRIVATE_JSON`. The private helper must
implement the owner-private file operations used by the peer CLI.

| Command | Private profile fields |
| --- | --- |
| All | `peerConfigFile`, `peerDatabase`, `grantFile` |
| `issue` | `controlDatabase`, `outputFile` (writes the safe grant policy for the sender) |
| `tool` | `mcpTokenFile`, `nativeOrigin`, `nativeTokenFile`, `port` (grantFile is the issued policy) |
| `broker` | `controlDatabase`, `spendingDatabase`, `managedModule`, `managedOptions`, `host`, `port`, `pollMs`, optional `tlsFile` |

Token files contain exactly `{ "token": "OWNER_PRIVATE_CAPABILITY" }`. Broker
grants contain the original private lease; sender policies omit it. Existing
controller and paid databases must already exist in private directories. Broker
imports the selected ManagedCloud module and continuously admits eligible inbox
requests under that pre-issued grant. Remote peer ingress requires the existing
TLS peer transport; the MCP tool itself binds literal loopback only.

In FLUJO, configure a `streamable` MCP server pointing to the tool's `/mcp`
endpoint with its private Authorization header. Put an MCP node before the
Process node and enable only `factory_capacity_request`. Worker-mode startup
keeps cloned schedules and Persona dispatch suppressed; an explicit Flow call
performs the request.

Run `scripts/native-capacity-smoke.mjs` with explicit `--application`,
`--expected-head`, fresh `--evidence` and `--private-module` paths. It copies
clean pinned FLUJO source into a private overlay, restores a fresh encrypted
workspace and exercises real Next worker endpoints, ExecutionEngine, MCP and
peer transport. Its model is a deterministic loopback fixture and its cloud
executor is injected. It tests a lost ACK, store/process restart, exact replay
and paid refusal. It retains raw private evidence and seals acceptance only
after actual worker closure. This establishes local native request admission;
deployed child autonomy, Modal inference, independent-host recovery and a
development-speed comparison still require separate proof.
