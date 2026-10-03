# Persistent task and cell closure — implementation proposal

Draft, 2026-10-02. This document comes from read-only inspection of `src/control.mjs`, `src/presentation.mjs`, and existing controller, retirement, Git-effect, and presentation tests. It does not change a controller database, resource, or source file.

The next patch should add explicit logical closure after a worker retires, reclaim unused logical allocation once, and preserve reviewed work for another coordinator to deliver. Physical resource retirement, task completion, logical capacity release, final provider billing, and worker quiescence must remain separate facts.

## Current behavior and actual gaps

| Finding | Existing evidence | Implication |
| --- | --- | --- |
| Cells have no closure method. `retired` is already understood by capacity and budget queries. | `src/control.mjs:71–93`; `src/presentation.mjs:139–146` | A physically removed worker can remain ready and consume allocation/capacity indefinitely. Merely setting its status to retired would discard its logical spent amount unless that amount is transferred to its parent. |
| Existing lease authority does not check the owner cell's status. | `src/control.mjs:122–129` | Adding cell retirement or a future draining state must also fence existing task and project tokens. Restricting only new claims is insufficient. |
| Enrollment accepts any status except retired. | `src/control.mjs:92` | A future draining state could be accidentally changed back to ready. Restrict enrollment to reserved/ready if such a state is ever introduced. |
| Running operational tasks have no completed/cancelled transition. | `src/control.mjs:94–142`, `243–254` | Pausing correctly revokes admission but leaves old running rows and occupied branch identities. A provider's absence cannot itself prove that a task succeeded. |
| Pause changes control epoch, not candidate/review history. | `src/control.mjs:167–173`, `267–268` | An unchanged verified Git candidate is already eligible for delivery under a fresh project lease after resume. Do not reset it or require another review merely because its producer retired. |
| Open effects preserve uncertainty across retirement. | `test/retirement-regressions.test.mjs`; `test/review-regressions.test.mjs:135–180` | Successful cleanup is compatible with unresolved earlier work. A destroyed app cannot turn a running/unknown provision or model call into not_applied. |

The stale ready cell and missing operational closure are persistence gaps. Retaining verified work and unknown effects during pause are intentional safety properties. A verified task should continue to be verified until delivered or explicitly abandoned; it is not a running execution.

## Smallest next patch

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

These are proposed signatures, not implemented APIs. Capture immutable input before any asynchronous evidence read. Revalidate the complete captured identity and all current database guards inside BEGIN IMMEDIATE. Permit these administrative cleanup/closure transitions while paused; they need the controller's existing trusted-local authority, not an obsolete worker lease. Avoid requiring unrelated projects or all factory effects to drain.

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

Keep the shared SpendingLedger entirely outside that transaction. Its started or retired-meter-pending reservation continues holding max(ceiling, observed charges); retirement does not cancel it, settle it, or replenish it. Only supported final billing releases the unused paid allowance. This preserves the current paidBudget lower-bound/null-final semantics independently of the cell tree.

## Causal effects and stale authority

The retirement guard must collect more than effects whose owner equals the cell ID:

- Every accepted/running/unknown effect owned by that cell, including its task and project effects.
- Its exact provisioning effect found through `effect_bindings['cell:' + cellId]`; provisioning can be owned by the parent or root.
- Open cleanup effects for each app bound to that same provisioning effect; cleanup is currently owned by root.
- Any open delivery with task_id belonging to a task being closed or released, even though the effect's scope is project. Checking openEffects('task', taskId) alone misses this case.

Use recorded bindings and effect identity, not caller-selected app names, broad project matches, or raw receipt searches. A task handoff need not wait for unrelated tasks in its project; normal project integration admission still enforces that project's delivery lane.

Accepted never-started work can use the existing accepted → not_applied path only when cancellation wins before startEffect. Started/unknown work retains the existing negative reconciliation guard. The new trusted Git CAS refusal lane remains the narrow exception for an actual completed request-bound refusal; a cloud absence observation is not an equivalent proof.

Add a ready-owner-cell check to authority() for both task and project leases. Continue using the existing owner/attempt/control epoch/token/expiry checks. Claims already require ready cells. Final cell retirement also expires project integration leases it owns, so a new coordinator can acquire a fresh project lease when its effect lane is clear. Do not change old effect owner epochs while settling completed operations.

release/complete/cancel clear current task execution tokens and expiry. Preserve the attempt of review/verified candidates because review binds that exact attempt. Existing-identity effect observation after retirement or epoch change must never create fresh dispatch. Messages are advisory trusted-local records, not lease authority; an old message cannot reopen a closed task or authorize a call. Any future message-driven dispatcher must obtain current authority rather than treating an attempt field as permission.

Root cannot be retired, rolled into a parent, or removed by these methods. Retired cell IDs and their app bindings are permanent: creating future workers requires new identities. Exact reservation replay may observe the historical retired row but cannot enroll it again.

## Resource evidence and reviewed-work handoff

A successful logical closure must describe the scope of resource evidence honestly:

- An unprovisioned reserved cell needs no invented provider absence check. A cancelled, never-started provisioning effect is sufficient only if start/dispatch cannot subsequently occur.
- A provisioned cell requires its exact cell/app/provision binding and matching completed owned-retirement intent, plus genuine provider retirement/absence evidence from the configured trusted adapter. Validate ownership/generation identity before observing absence. Cached local inventory, an expired lease, a local-only down result, a deleted credentials file, an arbitrary JSON `destroyed` status, or no response is insufficient for a physical-retirement claim.
- Qualify evidence through a dedicated trusted local runtime path that performs the actual ownership/provider inspection; do not accept worker-manufactured trusted booleans. Durable evidence should bind controller/cell/provision key/app identity, observation scope/time and its private journal/digest. If in-process proof is used, bind it to the controller and complete admitted resource identity and consume it once. Reopening requires a fresh genuine observation, not deserializing authority.
- Provider app/machine absence describes that resource generation at observation time. It does not prove every upstream inference request, other host, thread, model backend, or bill stopped. Keep workerQuiescence unverified and outstanding paid holds.

Before deleting remote storage, copy candidates and review evidence into durable coordinator-owned storage and retain original bytes and hashes. A digest without available bytes cannot support delivery. If already unavailable, preserve the history and report unavailable evidence; do not regenerate bytes and inherit the old review.

After producer retirement, leave verified unchanged. Resume, acquire a fresh project lease from a ready coordinator, and use executeGitDelivery with a fresh effect key and the original reviewed repository/ref/baseline/candidate. Existing admission rechecks the candidate and review file hashes. If the target advanced, genuine CAS refusal clears only that delivery intent; rebasing or changing bytes requires a new independently reviewed task/candidate. A succeeded delivery awaiting deliverTask should be finalized from its exact receipt, including while paused, before any abandonment decision.

## DTO and release plan

Cell retired, cleared task leaseExpiry/owner for released running tasks, logical root spend transfer, and normal closure events fit the current presentation shape. No credential/path/receipt/event-details projection should be added. Numeric revision and opaque cursor continue tracking controller events; heartbeat-only observations may still share a revision. paidBudget revision remains independent.

The new completed/cancelled task values do not fit current strict allowlists (`src/presentation.mjs:150`). Writing them first would make snapshot return 503; deployed BFF clients can also reject unknown enum values. Coordinate presentation and all active staff clients before the controller begins writing either value. Existing TEXT columns and active_branch partial index already support terminal values without a physical SQLite table migration, but that does not make the DTO addition compatible with old readers. Either deploy additive enum support to all readers first, or version the DTO and explicitly migrate consumers. Keep the read-only API's commands capability false.

If that coordination is not ready, land only retireCell plus releaseTask first, using existing status values. This safely reclaims cell capacity and queues unfinished tasks; it is an interim handoff, not operational completion. Add the explicit terminal task statuses in the coordinated follow-up. Do not disguise completion as rejected/delivered or silently reset tasks to ready.

Implement controller methods and dedicated lifecycle tests first; keep retirement-evidence qualification in the runtime adapter boundary. Add orchestration calls only after owned provider retirement is confirmed, using explicit per-task outcomes and leaves before parents. This proposal does not call those methods against the pilot's actual database.

## Meaningful qualification cases

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
