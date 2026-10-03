# Native cell queue runtime

`bin/native-cell.mjs` runs an explicit mission queue against the authoritative
local FactoryControl and SpendingLedger. It selects only immutable software
tasks whose `nativeMission` matches its configured cell, app, provision key and
worker snapshot identity. It does not import FLUJO's ambient schedules or create
tasks on its own.

Use Node 24 or newer:

```
node bin/native-cell.mjs run --private-module ABS --profile PRIVATE_JSON
node bin/native-cell.mjs once --private-module ABS --profile PRIVATE_JSON
```

The strict private profile contains exactly `controlDatabase`,
`spendingDatabase`, `client` and `cell`. Both databases must already exist and be
initialized in private directories; this command cannot initialize or reset
either policy. `client` is exactly `{ origin, tokenFile, worker, timeoutMs }`,
as described in [NATIVE_MISSIONS.md](NATIVE_MISSIONS.md). Its private token file
contains exactly `{ token }`.

`cell` contains exactly:

| Field | Meaning |
| --- | --- |
| `cellId`, `app`, `provisionKey` | Original provision-bound mission target |
| `worker` | Exact workspace, archive hash and compatibility tuple |
| `outputDirectory` | Absolute private result directory |
| `ttlMs` | Claim lifetime, 1,000–86,400,000 ms |
| `pollMs` | Queue/observation interval, 100–60,000 ms |

Outputs use `missionId + '.private.json'` under the configured directory.
An original intent whose destination does not match that binding is refused.
The daemon emits safe JSON status only when it changes; raw conversations and
credentials stay in private artifacts. SIGINT/SIGTERM stops further queue
admission, aborts this process's HTTP requests and fences a POST that has not
been invoked. An already invoked POST retains its uncertain outcome for later
GET recovery. Shutdown does not cancel the native Flow or release paid reservations.
Windows process termination can bypass JavaScript signal handlers; recovery
therefore relies on the durable intent, not a graceful-shutdown assumption.

Each tick reconciles existing running/unknown missions before admitting fresh
work, including while factory or paid admission is paused. Missing or unfinished
native results remain unresolved and cannot authorize another POST. An accepted
intent that never reached its dispatch phase requires operator reconciliation;
the daemon does not resume it. Fresh work keeps its ready status when paid
allowance is unavailable. The runner's actual ledger/controller fences still
decide whether a POST may be invoked after asynchronous preparation.

Claims for a given cell are serialized inside the controller transaction.
The daemon attempts at most one fresh mission per tick and rotates across ready
tasks so a bad preflight does not permanently starve other work. It skips
allowances that do not fit the available budget. A prior completed native Flow
permits the next mission while its software remains subject to separate review
and delivery; this adds no workspace/branch isolation guarantee.

An interruption between claim and intent admission leaves an unstarted lease.
New native claims record token-free provenance in the controller. Once that
lease expires or its factory epoch is fenced, the daemon can release it only
with exact original identity, no candidate/review, and zero lifetime task
effects. Older or ordinary claims without that provenance require the existing
trusted operator release procedure. Any admitted intent permanently prevents
this automatic release and a second execution request.

This runtime belongs beside the authoritative controller/ledger, or on that
coordinator with a fixed remote native origin. Deploying independent copies of
the ledger would not preserve the factory's total spending limit. The current
FLUJO cloud image uses Node 22, and ManagedCloud overrides its command.
[The service package](deploy/factory-service.md) now supplies a separate Node 24
coordinator and explicit local native companion. Its actual Docker acceptance
uses private fixture volumes and a synthetic model, including paused recovery
after both services restart and refusal of fresh work under a fully held budget.
Cloud deployment and shared authenticated remote authority remain separate work.
These checks prove selected local queue execution and restart recovery; they
do not prove paid inference, browser/MCP tools or accepted software delivery.
