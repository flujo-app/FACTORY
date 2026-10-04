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

The strict private profile contains `controlDatabase`,
`spendingDatabase`, `client` and `cell`, with an optional `powerScheduling` field.
Omitting that field retains the existing queue behavior and makes no power calls.
Both databases must already exist and be
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

Optional `powerScheduling` contains exactly `{ flyTokenFile, managementLeaseFile,
wakeCeilingCents, timeoutMs }`. Both file paths are absolute owner-private JSON.
The Fly file contains exactly `{ token }`; the management file contains the
existing lease's exact `{ scope, scopeId, cellId, epoch, controlEpoch, expires,
token }`, with `scope: "task"`. `wakeCeilingCents` is an explicit positive integer;
power `timeoutMs` is 100–60,000 ms. The command does not claim or renew this lease.
After explicit renewal, update its private file and restart the process.

Power configuration requires an already persisted `worker_power_enrolled`
binding for `cell.app`, matching the exact cell/app/provision/worker tuple. The
CLI constructs `createWorkerPowerController` with the same opened controller and
paid ledger, that original binding, the private Fly token, and the existing
`client.origin`/worker token. For power management, this origin must be an
existing Machine-specific HTTP loopback proxy reachable within this coordinator's
network namespace. Construction does not enroll,
start, stop or provision a worker; an explicit queue tick decides the transition.
No proxy is started automatically. See [WORKER_POWER.md](WORKER_POWER.md).

Power statuses are limited to `power_transition`, `power_observed`, `sleeping`
and the existing safe blocked/budget/paused results. Unknown/accepted/running
power intents permit observation only, including while paused. Expired management
authority refuses fresh transitions. Sleep retains the existing live-task/effect
fences; wake reserves its configured ceiling while leaving enough free allowance
for the selected mission. Machine/snapshot identity and current demand are
rechecked before mutation. Stopping compute does not settle paid reservations.

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
The optional [capacity-broker role](deploy/factory-service.broker.md) uses the
same existing private authority files and an explicit authenticated native
source profile. A separate local snapshot capture/restore preserved worker
configuration and dormant schedules, and exposed an inert MCP tool without
calling it. Its fully held budget retained one `not_applied` provision intent
and replayed the same key after broker restart. The native-cell queue's separate
budget refusal leaves its new task ready without effects. Neither proof admits
another paid resource or creates an independent authority replica.
Cloud deployment and shared authenticated remote authority remain separate work.
These checks prove selected local execution, source restoration and restart
recovery; paid inference, browser/other tool execution and accepted software
delivery remain open.
