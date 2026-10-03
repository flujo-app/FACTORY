# Modal operation observation

The operator API has a separate, authenticated read-only projection for registered
Modal pilot journals. It does not change the existing controller snapshot or event
contract. A controller journal, Modal operation journals, and the shared spending
ledger are separate authorities with separate revisions.

Configure journals when starting the server with `--modal-journals ABSOLUTE_PATH`.
The owner-private JSON file contains only this configuration:

```json
{
  "schemaVersion": 1,
  "journals": [
    {
      "runId": "modal-20261002-r3",
      "journalPath": "C:/Users/Moe/Documents/ChatGPT/FACTORY/.factory/modal-20261002-r3/modal.sqlite"
    }
  ]
}
```

Each run ID and absolute journal path must be unique. At most 16 journals may be
registered. File paths belong to operator configuration; HTTP clients cannot
select files. The configuration file must be a bounded, regular, owner-private
file. No provider connection or paid dispatch is made by this view.

`GET /v1/factories/factory-live-pilot/modal-runs` and its `/v1/modal-runs` alias
use the existing private bearer credential, require GET, reject query parameters,
and send `Cache-Control: no-store`. They have no browser CORS contract. Responses
identify `schemaVersion: 1`, `factoryId`, `buildRevision`, `observedAt`,
`scope: "registered-modal-operation-journals"`, and
`capabilities: {"observation": true, "commands": false}`. The payload contains
`modalRuns` and the separately read `paidBudget`. This route remains readable
when the controller database is unavailable.

For each readable run, the projection exposes operation identity, operation name,
state, creation/update timestamps, and typed, allowlisted outcome metadata.
Credentials, private request JSON, raw response text, prompts, local paths,
provider logs, and reconciliation proof files are excluded. Private request
bindings are checked against the configured run ID and operation. Unreadable or
invalid journals are reported as unavailable individually; a healthy peer's
record is still returned. Missing journals are never created.

`journalRevision` is a SHA-256 fingerprint of the projected operation content,
not an ordered event sequence or a controller cursor. `revisionKind` explicitly
states `content-sha256`. Repeated reads preserve unknown outcomes. The reader
rejects disappearing intents, changed immutable identity, and state/timestamp
regression against its own previously observed records. A new server process
starts a new observation history; this guard is not a remote consensus protocol.

These are persisted local records. The response read time is not a fresh Modal
control-plane observation. A recorded App stop or Volume deletion does not prove
present account-wide resource absence, final billing, inference success, or native
FLUJO Flow execution. In particular, a successful cleanup record does not resolve
an unknown prefetch record.

The paid budget has its existing independent numeric revision and registered
reservation scope. Partial usage observations and successful cleanup do not
release reservation holds. Final billing remains unknown until separately
qualified evidence supports settlement.

The existing server on port 4343 and the brain-online adapter keep their
snapshot/events contract. Any new frontend integration must explicitly opt into
this separate endpoint and validate its scope and revision semantics.
