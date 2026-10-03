# Persistent task and cell closure — implemented subset and proposal

Updated 2026-10-03. The initial subset below is implemented in source commit
`0948fdd9ff7f5d379982e6e7286fd220236a1993`. The later sections preserve the broader
2026-10-02 proposal and its historical baseline analysis. The narrow provider-bound
path described below is implemented in `8dce857df549f29c69e566fa7d927196cb324c3c`.
Updating this document
does not invoke a controller method, change a database or make a provider call.

Physical resource retirement, task completion, logical capacity release, final
provider billing and worker quiescence remain separate facts.

## Implemented initial subset

The trusted-local `FactoryControl` methods use existing task/cell states:

```text
releaseTask(taskId, { closureId, expectedAttempt, expectedOwner,
                      expectedStatus: 'running', expectedTaskControlEpoch,
                      expectedFactoryEpoch })
retireCell(cellId, { closureId, expectedParent, expectedStatus,
                    expectedAllocation, expectedSpent, expectedFactoryEpoch })
```

Both capture and validate a closed set of input fields, bind `closureId` to the
exact request digest, and recheck current identities in one `BEGIN IMMEDIATE`
transaction. Fresh closure uses the exact current factory epoch. Exact completed
replay can observe the same recorded result across later factory epochs without
another event, transfer or dispatch; conflicting closure bytes fail closed.

`releaseTask` changes only an exactly matched running task with no submitted
candidate/review and no causal open task, project-delivery or cleanup effects to
ready. It clears current owner/token/expiry/control epoch while preserving the
specification, branch, attempt and history. A new task claim increments the
attempt and fences any old release replay. The recorded task epoch and current
factory epoch are distinct inputs, so trusted-local closure can occur after pause.

`retireCell` changes only non-root reserved/ready leaves that have **never been
provision-bound**. Every recorded provision binding is refused, including a
terminal never-started intent; actual provider absence cannot bypass this subset.
Non-retired children, running owned tasks and causal accepted/running/unknown
effects block closure. Logical allocation invariants use integer-safe sums; the
cell's spent amount transfers to its parent exactly once, unused allocation and
cell capacity are released, and the retired identity remains historical. Reviewed
or delivered candidates, reviews, owner provenance and effects are preserved.

Lease authority now requires a ready owner cell in addition to the existing
attempt/control epoch/token/expiry checks. Cell retirement revokes its current
task execution tokens and project integration expiry. It does not settle unknown
effects, alter candidate hashes, mutate the shared paid ledger or establish
worker/provider quiescence. New cells require new identities.

This source was independently reviewed and qualified in the combined isolated
**188/188** suite. Adoption matched the qualified bytes after line-ending
normalization; no shared-suite rerun occurred. Qualification and exact adoption
evidence are recorded in [QUALIFICATION.md](QUALIFICATION.md). No DTO enums were
added, the running API was not restarted, and browser commands remain disabled.

The real documentation task's `docs-builder` and `docs-reviewer` leaves were then
logically retired. Independent audit confirmed exactly two original retirement
events (15/16), both zero-allocation/spent leaves, root paused at epoch 2, zero
open effects, one historical successful Git delivery, preserved task attempt 1
and full specification/candidate/review/owner history. Paid accounting was
unchanged and `workerQuiescence` remains unverified. Protected report:
`.factory/flujo-token-docs-20261003/logical-retirement-report.private.json`, SHA-256
`cc880cb140732000a33017ef742e6663fb7d5edca5c06a02d969ad3677353614`.
The executed source-bound closure wrapper SHA-256 is
`3bf44c228d2abe34cfff12185de7cfa5ca5a3a69a5e4658c2f5374e73a6084e9`.
The protected independent adoption/closure/paid audit, published at
**02:42:43.346 UTC**, is
`.factory/integration-stage/run-2026-10-03T01-49-59-785Z-offline/independent-adoption-closure-paid-audit-88d56140-3690-4057-91ee-86154ca54a24.private.json`,
SHA-256 `fa2c64fcb94e2d9c506fab0453715e12c9237e88981bf1b16d29fcd10abccbe4`.

`completeOperationalTask`, `cancelTask`, completed/cancelled task DTO values
and targeted draining remain **proposals**. They
are not authorized by the existing logical closure methods. The low-memory HTTP
download path is adopted source preparation, with no cloud execution or proven
performance improvement.

## Implemented provider-bound Fly closure

Source `8dce857df549f29c69e566fa7d927196cb324c3c` adds this trusted-local API:

```js
const input = {
  closureId, expectedParent, expectedStatus, expectedAllocation, expectedSpent,
  expectedFactoryEpoch, provisionKey, retirementKey
};
const proof = await observeProvisionedCellRetirement(control, cellId, input,
  { managedDirectory, org, workspace, flyPath });
const receipt = providerRetirementEvidence(proof, control);
// Record the safe receipt before applying the logical transition.
const result = control.retireProvisionedCell(cellId, input, proof);
```

Here `input` is the same exact closed request supplied to the observer. The built-in
observer directly reads bounded, stable ManagedCloud records and invokes a scoped
read-only Fly CLI inventory. It requires successful original provisioning and
matching owned cleanup, cloud-confirmed destroyed records, exact cell/app/effect
bindings and correlation to the original admitted source/workspace/image request
and timestamps. The original controller receipt did not retain attempt/owner IDs;
those correlations come from the private managed records.

The opaque capability binds the exact controller object and request. Consumption
checks its 60-second wall/monotonic freshness, current database identities, record
hashes and file identities inside the existing closure transaction. Existing
leaf-first, running-task, causal-open-effect and allocation-conservation guards
remain in force. Exact completed replay returns the original result without a
fresh capability, provider command, event or allocation transfer. `retireCell`
continues to reject every provision-bound cell.

The result's resource scope is
`owned-fly-teardown-recorded-and-app-not-returned-by-configured-inventory`.
The inventory describes the configured credential's returned view. This evidence
supports logical closure; physical global absence, worker quiescence and final
billing are separate facts. `workerQuiescence` stays unverified and the paid ledger
is outside this transaction. New DTO enums and browser commands were not added.

The complete frozen repository suite passed **288/288**. Independent source,
committed-tree and actual outcome audits passed. The original Fly pilot's child
was retired at event 90, then its parent at event 91. Original history, reviewed
work, bindings and the unfinished root launch task remain preserved. Root logical
unallocated capacity changed from 4,000 to 10,000 cents: the nested child's 1,500
was inside the parent's 6,000, so only 6,000 returned to root. All US$100 remains
held under paid revision 17. The existing presentation process correctly projected
the new state under its actual loaded build `8f5a940`. Exact evidence is in
[QUALIFICATION.md](QUALIFICATION.md).

## Historical baseline analysis and broader proposal

The sections below retain the original pre-implementation analysis, source line
references and proposed signatures. Descriptions of the old controller refer to
that historical baseline, not current source. The implemented API and limits are
defined above; broader completion/provider-evidence extensions below remain a
proposal.

### Historical behavior and gaps

| Finding | Existing evidence | Implication |
| --- | --- | --- |
| Baseline cells had no closure method; `retired` was already understood by capacity and budget queries. | Historical `src/control.mjs:71–93`; `src/presentation.mjs:139–146` | Current methods close unprovisioned leaves and narrowly qualified successful Fly teardown, with exact-once spent transfer. |
| Baseline lease authority did not check the owner cell's status. | Historical `src/control.mjs:122–129` | Current authority now requires a ready owner cell and retirement invalidates task/project execution authority. |
| Enrollment accepts any status except retired. | `src/control.mjs:92` | A future draining state could be accidentally changed back to ready. Restrict enrollment to reserved/ready if such a state is ever introduced. |
| Running operational tasks have no completed/cancelled transition. | `src/control.mjs:94–142`, `243–254` | Pausing correctly revokes admission but leaves old running rows and occupied branch identities. A provider's absence cannot itself prove that a task succeeded. |
| Pause changes control epoch, not candidate/review history. | `src/control.mjs:167–173`, `267–268` | An unchanged verified Git candidate is already eligible for delivery under a fresh project lease after resume. Do not reset it or require another review merely because its producer retired. |
| Open effects preserve uncertainty across retirement. | `test/retirement-regressions.test.mjs`; `test/review-regressions.test.mjs:135–180` | Successful cleanup is compatible with unresolved earlier work. A destroyed app cannot turn a running/unknown provision or model call into not_applied. |

The historical stale-ready gap is now addressed for unprovisioned cells and the
narrow successful Fly teardown path. Broader provider outcomes and operational
completion/cancellation remain gaps.
Retaining verified work and unknown effects during pause remains intentional. A
verified task stays verified until delivered or explicitly abandoned; it is not a
running execution.

## Original patch proposal and remaining extensions

Use the existing reserved/ready/retired cell states first. An atomic final retirement transaction can recheck tasks, effects, descendants, and allocation before changing ready/reserved to retired. It does not need an intermediate draining enum to handle the already-paused pilot. This also avoids adding a new cell value to the current DTO. For a busy continuously admitting service, a separate targeted drain operation can follow later; that operation would block admission while retaining allocation and capacity.

Add four trusted-local administrative controller methods, not worker or browser commands:

```text
releaseTask(taskId, { expectedAttempt, expectedOwner, expectedStatus: 'running',
                      expectedTaskControlEpoch, expectedFactoryEpoch })
completeOperationalTask(taskId, { expectedAttempt, expectedOwner, expectedStatus,
                                expectedTaskControlEpoch, expectedFactoryEpoch,
                                completionEffectKeys, closureId })
cancelTask(taskId, { expectedAttempt, expectedOwner, expectedStatus,
                    expectedTaskControlEpoch, expectedFactoryEpoch, closureId })
retireCell(cellId, { expectedParent, expectedAllocation, expectedSpent,
                   expectedFactoryEpoch, retirementEvidence })
```

These are the original proposed signatures, not the current API: `releaseTask`
and `retireCell` now use the exact initial-subset fields shown above. The other
methods and original JSON `retirementEvidence` argument remain unimplemented. The
current provider path uses a separate method and opaque capability, described
above. A future extension
should capture immutable input before asynchronous evidence reads, revalidate
inside `BEGIN IMMEDIATE`, and use trusted-local administrative authority while
paused. Avoid requiring unrelated projects or all factory effects to drain.

The task's recorded control epoch and the current factory epoch are separate CAS inputs. A task started before pause normally has an older task control epoch; that is an identity to preserve/check, not a reason to refuse cleanup. Never require that old task epoch to equal the current factory epoch. Exact completed closure replay may observe its recorded result across later factory epochs without granting a new transition.

| Transition | Required facts | Preserved result |
| --- | --- | --- |
| running → ready, via releaseTask | Exact task attempt/owner/status match; no causal open task or associated project delivery effects. For this initial transition, the running task has no submitted candidate/review. | Specification, branch, original attempt and historical events survive. Clear current owner, token_hash, expires and control_epoch. A new claim increments attempt and issues a new token. |
| running/ready → completed, via completeOperationalTask | Explicit operational completion chosen by the local coordinator; matching terminal successful operational effect receipts support the stated work. Reject tasks with a deliveryTarget or an existing candidate/review. No causal open effects. | Records that an operation completed, not that reviewed software was integrated. Preserve specification and effect history; clear execution authority. |
| ready/running/review/verified → cancelled, via cancelTask | Explicit abandonment, exact current task identity, no causal open effects, and no successful matching delivery awaiting finalization. | Preserve specification, candidate, review, artifact hashes and their original attempt. Clear execution authority. Never label abandonment delivered. |
| reserved/ready → retired, via retireCell | Non-root leaf; no non-retired children; owned running tasks explicitly released/completed/cancelled; causal effects terminal; exact bound resource retirement qualified; allocation invariants valid. | Cell identity, parent, allocation, final logical spent, purpose, heartbeat and messages remain historical. Transfer logical spent to parent exactly once. |
| review → review; verified → verified during producer retirement | Artifact/evidence remains durably available. No worker execution token is retained. | Original producer owner ID, candidate/review hashes, specDigest and review.attempt stay unchanged. Producer ID is historical provenance, not active execution authority. |

Operational task classification must be explicit. For new launch/cleanup tasks, record an immutable specification field such as `taskType: 'operation'`; completion checks that type and named task-bound success receipts. Existing pilot launch tasks lack that field: support a separately identified trusted-local legacy operational closure with exact existing provisioning/cleanup keys and an auditable closure event. Do not rewrite their specification or spec_digest to retrofit a type. A failed operation may be cancelled or released; it must not be completed merely because its resources no longer exist.

For local-only operational tasks, define their own bounded completion-evidence contract when they are introduced. Do not require a provider receipt for unrelated local work or let a generic success string bypass source review. The first completion implementation can remain specific to the existing launch/cleanup operations.

Record closure events with closureId/requestDigest, prior state/owner/attempt and the named supporting effect IDs. A repeated exact terminal transition observes its recorded result without another event or allocation transfer. Conflicting closure input fails closed. A replay of an old release must not release a newly claimed attempt. Existing effects, provisioning bindings and message identities are never deleted or rebound.

## Allocation conservation

For every admitted parent:

```text
parent.spent + sum(allocation of direct non-retired children) <= parent.allocation
```

Here spent is logical consumption retained after children close. It is not a provider bill. The current controller has no public method to meter this value; a follow-up must not derive it from the paid ledger or invent spend from observed wall time. Existing zero-spent cells release their entire unused allocation.

Leaf retirement should atomically do the following:

1. Reject root, validate the exact cell and parent, and require all direct children retired.
2. Check nonnegative safe integer allocation/spent and spent <= allocation. Use integer-safe/BigInt sums for the parent invariant; fail rather than clamp corrupted or overallocated state.
3. Check tasks, resource evidence and the causal open-effect union described below.
4. Set the cell to retired and add its final spent to parent.spent once, preserving the retired row's own spent for history.
5. Invalidate execution authority associated with the closing cell, then append one cell_retired event containing transferred and released logical cents and safe evidence references.

The parent's immediate unallocated capacity grows by `cell.allocation - cell.spent`. The root's committed amount need not change when only a grandchild retires: the root still holds its direct child's full allocation. Do not release that allocation twice or sum all descendants into root commitment.

Example: root allocates 4,000 cents to parent. Parent has 300 logical cents of its own consumption and two children allocated 1,500 and 800. They finish with 600 and 100 logical cents. Closing the leaves transfers 700 to parent.spent, which becomes 1,000. Root still holds the parent's 4,000. Closing parent transfers 1,000 to root.spent and releases 3,000 logical cents. Replaying any of those closures changes nothing.

Keep the shared SpendingLedger entirely outside that transaction. Its started or retired-meter-pending reservation continues holding max(ceiling, observed charges); retirement does not cancel it, settle it, or replenish it. Only supported final billing releases the unused paid allowance. Conservatively rounded partial observations and unknown final spend remain independent of the logical cell tree; rounded cents must not be presented as an exact total or strict monetary lower bound.

## Causal effects and stale authority

The retirement guard must collect more than effects whose owner equals the cell ID:

- Every accepted/running/unknown effect owned by that cell, including its task and project effects.
- Its exact provisioning effect found through `effect_bindings['cell:' + cellId]`; provisioning can be owned by the parent or root.
- Open cleanup effects for each app bound to that same provisioning effect; cleanup is currently owned by root.
- Any open delivery with task_id belonging to a task being closed or released, even though the effect's scope is project. Checking openEffects('task', taskId) alone misses this case.

Use recorded bindings and effect identity, not caller-selected app names, broad project matches, or raw receipt searches. A task handoff need not wait for unrelated tasks in its project; normal project integration admission still enforces that project's delivery lane.

Accepted never-started work can use the existing accepted → not_applied path only when cancellation wins before startEffect. Started/unknown work retains the existing negative reconciliation guard. The new trusted Git CAS refusal lane remains the narrow exception for an actual completed request-bound refusal; a cloud absence observation is not an equivalent proof.

The initial subset has added the ready-owner-cell check to `authority()` for task
and project leases while preserving the owner/attempt/control epoch/token/expiry
checks. Final logical cell retirement expires project integration leases it owns,
so a ready coordinator can acquire a fresh lease when its effect lane is clear.
Do not change old effect owner epochs while settling completed operations.

release/complete/cancel clear current task execution tokens and expiry. Preserve the attempt of review/verified candidates because review binds that exact attempt. Existing-identity effect observation after retirement or epoch change must never create fresh dispatch. Messages are advisory trusted-local records, not lease authority; an old message cannot reopen a closed task or authorize a call. Any future message-driven dispatcher must obtain current authority rather than treating an attempt field as permission.

Root cannot be retired, rolled into a parent, or removed by these methods. Retired cell IDs and their app bindings are permanent: creating future workers requires new identities. Exact reservation replay may observe the historical retired row but cannot enroll it again.

## Proposed provider evidence and reviewed-work handoff

This section preserves the broader original proposal. Current `retireCell` still
rejects every provision-bound identity. The implemented separate
`retireProvisionedCell` path described above handles narrowly qualified successful
owned Fly teardown; broader outcomes and adapters remain future work.

A successful logical closure must describe the scope of resource evidence honestly:

- An unprovisioned reserved cell needs no invented provider absence check. A cancelled, never-started provisioning effect is sufficient only if start/dispatch cannot subsequently occur.
- A provisioned cell requires its exact cell/app/provision binding and matching completed owned-retirement intent, plus genuine provider retirement/absence evidence from the configured trusted adapter. Validate ownership/generation identity before observing absence. Cached local inventory, an expired lease, a local-only down result, a deleted credentials file, an arbitrary JSON `destroyed` status, or no response is insufficient for a physical-retirement claim.
- Qualify evidence through a dedicated trusted local runtime path that performs the actual ownership/provider inspection; do not accept worker-manufactured trusted booleans. Durable evidence should bind controller/cell/provision key/app identity, observation scope/time and its private journal/digest. If in-process proof is used, bind it to the controller and complete admitted resource identity and consume it once. Reopening requires a fresh genuine observation, not deserializing authority.
- Provider app/machine absence describes that resource generation at observation time. It does not prove every upstream inference request, other host, thread, model backend, or bill stopped. Keep workerQuiescence unverified and outstanding paid holds.

Before deleting remote storage, copy candidates and review evidence into durable coordinator-owned storage and retain original bytes and hashes. A digest without available bytes cannot support delivery. If already unavailable, preserve the history and report unavailable evidence; do not regenerate bytes and inherit the old review.

After producer retirement, leave verified unchanged. Resume, acquire a fresh project lease from a ready coordinator, and use executeGitDelivery with a fresh effect key and the original reviewed repository/ref/baseline/candidate. Existing admission rechecks the candidate and review file hashes. If the target advanced, genuine CAS refusal clears only that delivery intent; rebasing or changing bytes requires a new independently reviewed task/candidate. A succeeded delivery awaiting deliverTask should be finalized from its exact receipt, including while paused, before any abandonment decision.

## Proposed DTO extensions and release plan

Cell retired, cleared task leaseExpiry/owner for released running tasks, logical root spend transfer, and normal closure events fit the current presentation shape. No credential/path/receipt/event-details projection should be added. Numeric revision and opaque cursor continue tracking controller events; heartbeat-only observations may still share a revision. paidBudget revision remains independent.

The new completed/cancelled task values do not fit current strict allowlists (`src/presentation.mjs:150`). Writing them first would make snapshot return 503; deployed BFF clients can also reject unknown enum values. Coordinate presentation and all active staff clients before the controller begins writing either value. Existing TEXT columns and active_branch partial index already support terminal values without a physical SQLite table migration, but that does not make the DTO addition compatible with old readers. Either deploy additive enum support to all readers first, or version the DTO and explicitly migrate consumers. Keep the read-only API's commands capability false.

The compatible `retireCell` plus `releaseTask` subset has now landed using existing
status values. It reclaims eligible logical capacity and permits explicit task
handoff; it is not operational completion. Explicit terminal task statuses belong
in the coordinated follow-up. Do not disguise completion as rejected/delivered or
silently reset tasks to ready.

The initial controller methods and dedicated lifecycle cases are qualified; actual
logical closure of the documentation and original Fly leaves is recorded above.
Provider-evidence qualification belongs at the trusted runtime boundary. Broader
provider-bound orchestration must use explicit task outcomes and leaves before
parents. This document itself performs no orchestration.

## Original qualification plan

This historical plan mixes the implemented subset with remaining extensions.
Operational completion/cancellation and new DTO-enum rollout cases below are
still proposals; the initial subset's executed qualification is recorded above.

1. Two real SQLite connections/processes race to retire the same leaf: one transfer/event, identical exact replay, conflicting evidence rejected. Reopen and replay again with no further release.
2. Nested example above: leaf-first conservation, no root descendant double count, final unused release correct, maxCells slot available for a new identity. Reject root retirement and parent closure with a non-retired child.
3. Retire an unused reserved cell without provider claims. Preserve old identity; reserve/enroll/provision replay cannot recreate it.
4. A bound provision effect owned by root is still unknown: actual app absence does not clear it or release the causal cell. An unrelated unknown effect elsewhere does not prevent a clean leaf closing.
5. An owned task or associated project delivery is accepted/running/unknown: release/closure refuses. Ordinary completion can settle after pause; narrow Git refusal keeps its existing behavior. No general negative reconciliation relaxation.
6. An old task/project token cannot renew, submit, admit, or start after cell closure. Race claim/renew/admit against closure; transaction ordering either preserves admitted work as a blocker or retires and rejects the stale action.
7. Task release exact replay is idempotent; replay after a new claimant/attempt fails. Operational completion requires its typed, matching success evidence; provider absence alone cannot complete it. Cancellation preserves evidence and frees the active branch without claiming delivery.
8. A verified candidate survives producer/verifier cell retirement, pause/resume and a fresh root project lease; actual Git delivery succeeds only for unchanged reviewed bytes. Tampered/unavailable artifacts and rebased heads still require new evidence.
9. Snapshot remains atomic during concurrent leaf closure: transferred root spend, retired status and cursor are mutually consistent; old token/path/receipt fields remain absent. Explicitly test new terminal enum rollout rather than allowing an unnoticed 503.
10. Cell/task closure leaves paid-ledger bytes, reservations, ceilings, pause markers, knownMeteredCents and final billing state unchanged. Remote retirement does not label workerQuiescence verified.
