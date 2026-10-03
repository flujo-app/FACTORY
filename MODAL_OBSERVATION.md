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

The snapshot/events contract stays compatible. The historical port4343 server
was later observed unreachable; the restored service is on port4344. Any new frontend integration must explicitly opt into
this separate endpoint and validate its scope and revision semantics.

## Qualified local run

Implementation build `67997585baa897bd7586fe21b9a755c89739a1a3` initially ran on
`127.0.0.1:4344` with the three existing Modal pilot journals registered. Its
full source combination passed 270/270 results, exit 0, with no skips or
cancellations and unchanged source bytes during execution. The first recorder's
text/TAP format mismatch was preserved before one corrected qualification run.

An actual authenticated HTTP witness at 03:05:45.936–03:05:46.130 UTC on October 3
returned all 15 historical operations with three unknown prefetch outcomes.
Journal and spending contents and main/WAL bytes stayed unchanged. Shared paid
revision 17 still holds all US$100, with no free admission capacity, 24 cents in
conservatively rounded partial observations, and unknown final billing. No
provider call, paid dispatch, inference, or native FLUJO Flow occurred in this
verification. Exact evidence and remaining proofs are in
[QUALIFICATION.md](QUALIFICATION.md).

The service was restored at build `8f5a94048e9c8be007cf3b5229607783b49cd47f` on
port4344 after both previous endpoints were observed unreachable. Its frozen full
combination passed274/274; actual HTTP checks at04:04:51.158–04:04:51.369UTC again
returned three journals/15operations with unchanged logical state and main/WAL
bytes. Paid revision17 and its full US$100 hold remain unchanged. The model startup
changes at this build are prepared offline; no inference/nativeFlow success follows
from restoring journal visibility. The old port4343 endpoint was not restored.

Repository runtime source `8dce857df549f29c69e566fa7d927196cb324c3c` subsequently
qualified provider-bound logical cell closure with 288/288 checks. Actual HTTP
reads at 04:34:51 UTC projected Fly revision 91 and both retired worker cells, while
the existing presentation process remained actual build `8f5a940`. This controller
change did not alter the three Modal journals, their 15 operations, their three
unknown prefetch outcomes or paid revision 17. The shared paid ledger still holds
all US$100 with zero new paid admission capacity and unknown final billing.
HTTP witness SHA-256:
`1e545a0d0dca944e0daaae73d21486e4e00a92e0ba90b4bf5bd7be5644361bb4`.
