# Budget-only factory growth

Source `72aec7cd64ff7d55ba8c7cb31bf371dee8a88044` provides explicit budget-only
growth. It removes factory cell-count and delegation-depth ceilings and the
schema-2 capacity grant's child-count ceiling. Every child still needs a parent
allocation; every grant retains its lifetime monetary ceiling; paid dispatch
still needs admission from the one shared SpendingLedger. Lease, role, template,
native identity, expiry and replay checks remain authority constraints.

Legacy initialization and schema-1 grants keep their existing finite limits.
Missing, malformed or unknown policy fields never select budget-only behavior.
The exact durable factory policy is:

```json
{
  "schemaVersion": 2,
  "mission": "Improve FLUJO development speed",
  "budgetCents": 10000,
  "growthMode": "budget-only",
  "maxCells": null,
  "maxDepth": null
}
```

## Initialize a new controller

Use Node 24 or newer and an explicit absolute path for a new controller:

```powershell
$factoryDatabase = Join-Path (Get-Location) '.factory\new-controller.sqlite'
'{"mission":"Improve FLUJO development speed","budgetCents":10000,"growthMode":"budget-only"}' |
  node bin/factory.mjs init $factoryDatabase
```

Numeric `maxCells` or `maxDepth` values cannot be combined with this mode.
Initializing a controller does not initialize paid allowance or deploy workers.

## Transition an existing controller

This is a trusted local operator interface over an existing initialized database.
The two growth commands reject missing, blank, foreign or aliased main files
before constructing a writable controller. They do not establish a private ACL
or confer remote authority; use the existing trusted owner-controlled directory.

Prepare compatible writers and readers before live activation. First confirm the
explicit database is initialized, pause admission, then read its post-pause epoch
and policy digest. Submit those exact values with a stable transition ID:

```powershell
$factoryDatabase = 'C:\ABSOLUTE\EXISTING\control.sqlite'
node bin/factory.mjs growth-policy $factoryDatabase
if ($LASTEXITCODE -ne 0) { throw 'Initialized controller required' }
node bin/factory.mjs pause $factoryDatabase
if ($LASTEXITCODE -ne 0) { throw 'Pause failed' }
$factoryGrowth = node bin/factory.mjs growth-policy $factoryDatabase | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Policy read failed' }
@{
  transitionId = 'budget-growth-01'
  expectedFactoryEpoch = $factoryGrowth.epoch
  expectedPolicyDigest = $factoryGrowth.policyDigest
} | ConvertTo-Json -Compress | node bin/factory.mjs budget-growth $factoryDatabase
if ($LASTEXITCODE -ne 0) { throw 'Transition refused' }
```

The transaction preserves mission, total allocation, cells, tasks, effects and
grant history; it appends one bound transition event, advances the epoch and
leaves admission paused. Exact replay with the same ID and request returns the
original transition while paused. Reusing the ID for a different request is a
conflict. Old authority remains stale. Resume and replacement task leases/grants
are separate deliberate operations. Uncertain effects still need reconciliation
of the original intent before takeover; changing the policy never relaunches them.

## Issue a capacity grant

Keep all existing [standing-grant fields](NATIVE_CAPACITY.md), and select
`schemaVersion: 2`, `growthMode: "budget-only"`, `maxChildren: null`. This requires
factory policy schema 2. A grant ID cannot switch growth schemas across credential
generations; use a fresh grant ID for a mode change. Schema-1 grants retain their
count cap even under a budget-only factory.

`maxBudgetCents` remains the grant's lifetime allocation ceiling across all its
credential generations. Refused or uncertain admitted requests retain their
original allocation and intent. Rotation, expiry, refusal and policy migration
do not reset financial history or release uncertain paid holds. Service startup
does not initialize authority or perform this policy transition.

## Qualified scope and live status

The full suite passed 456/456 and the focused suite 60/60. Actual local Docker
capture/restore, schema-2 admission refusal and broker restart passed. No paid
provider operation was performed. Exact identities and evidence are in
[QUALIFICATION.md](QUALIFICATION.md).

On October 3 the original controller changed from legacy paused epoch 4/revision
91 to budget-only paused epoch 5/revision 92. Transition
`budget-growth-live-20261003` removed its count/depth ceilings while preserving
the original mission, 10,000-cent budget and every historical row. The original
`8f5a940` API process served the resulting state without replacement. Admission
was not resumed, existing tasks were not closed, and no live schema-2 standing
grant was issued. Exact execution and separate read-only reconciliation are
recorded in [QUALIFICATION.md](QUALIFICATION.md).

All US$100 is held, with zero available paid admission and final billing unknown.
Budget-only policy does not establish deployed recursive peers or independent-host authority.
Large-history presentation pagination also remains future work; its existing
10,000-row response guard is not a provisioning quota or a scale qualification.
