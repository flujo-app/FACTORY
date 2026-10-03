# Native FLUJO outcome repair

The factory delivered a reviewed local FLUJO runtime change that prevents replayed
Activities from corrupting cumulative Behavior outcome measurements. The exact
candidate passed **213 tests across 18 suites**, a full TypeScript check and lint
with zero warnings. This improves the correctness of FLUJO's self-improvement
feedback; development speed has not been measured.

## Problem and resulting behavior

The previous metric kept cumulative counters but retained only the last 500
Activity identities. Replaying an earlier eligible Activity counted it again.
The real-service baseline reproduced a consequential example: 501 distinct
samples included 331 successes and 170 failures, compared with an 81/100 success
baseline. Replaying an evicted failure changed the denominator to 502 and the
verdict from `stable` to `regressed`, crossing the unchanged 15 percentage point
threshold. Automatic rollback could act on that false regression when enabled.

The repair keeps exact inclusion identities and counters in the same versioned
metric record, using FLUJO's existing atomic JSON replacement. Sampling and
evaluation use the shared Persona runtime lock; evaluation reloads the current
metric before deciding whether to roll back. The terminal dispatcher confirms
the outcome projection independently of Task synchronization and leaves failed
projection work retryable without repeating authoritative Flow execution.

Complete v1 membership migrates without changing counters, baseline or policy.
When v1 has already lost identities, migration preserves the historical results,
marks `legacy_incomplete`, and suppresses prospective sampling and automatic
rollback. The UI explains that incomplete history in English and Spanish.

## Exact source and local delivery

| Item | Value |
| --- | --- |
| Task | `behavior-outcome-idempotency`, attempt 1 |
| Project | `flujo-behavior-outcomes` |
| Baseline | `d68492712315d30c856c8d2ba95b0a26a859bd18` |
| Candidate | `549792e1839931e862e6a305eb0d9ce2b82ae905` |
| Author branch | `codex/factory-behavior-outcome-idempotency` |
| Delivered ref | `refs/heads/codex/factory-reviewed-behavior-outcome-idempotency` |
| Changed files | 16 |
| Checkout | `.factory/flujo-outcome-idempotency-20261003/worktree` |

The candidate has the exact baseline as its sole parent. Its Git blobs match the
tested source after LF normalization. A separate verifier accepted the immutable
specification, attempt, candidate, diff, source and qualification evidence before
delivery. The driver verified all three qualification reports and their current
source pins, plus the existing 54-source, 288-test Factory runtime qualification.

The destination was absent before delivery. An exclusive baseline seed intent
and create-if-absent Git CAS prepared it. The reviewed candidate then passed the
trusted delivery CAS and a destination read. The controller recorded a succeeded
effect and delivered task, paused at epoch 2, and retired its two
never-provision-bound zero-allocation logical roles. Task and review history
remain present; there are no unresolved effects in this task's controller.
An independent outcome audit verified the direct destination and both reflog
updates, preserved task/review/effect history, and the actual 16-event controller
sequence: review 9, integration 10, delivery effect 11/12, delivered task 13,
pause 14 and logical closures 15/16.

The managed checkout shares the owner repository's Git common directory. The
authorized branches and reflogs are therefore added there; preservation covers
the owner's working checkout head, index, status and recorded source bytes.

This is a local reviewed branch. Upstream publication, merge, deployment, native
Flow invocation and rented-model inference were not performed for this task.
The main Fly pilot controller and port 4344 observation service were not changed
to adopt this separate task controller.

## Verification and preservation

The baseline ran the actual service and storage code: 11 assertions passed and
the new replay regression failed. The final frozen candidate ran from
05:30:03.794 to 05:33:56.505 UTC on October 3, 2026: **213/213 passed**, with no
failed, pending or runtime-error suites. Its 2,146 raw source pins stayed stable.

The eight new process cases cover more than 500 identities across restart and
native recovery capture/restore, duplicate and distinct sampling from two real
OS processes, process kills immediately before and after the inclusion-bearing
native rename, stale regression evaluation, complete and truncated legacy
migration, and native Persona deletion. Related service, dispatcher, learning,
migration, recovery, deletion, route, UI and test-registration suites passed.

Twenty-nine protected paid/provider history pins remained unchanged, as did the
owner FLUJO checkout's recorded head, index and 60 dirty paths. The isolated
checkout used its own installed dependencies and temporary test data roots.
The lockfile and owner checkout were preserved. No new cloud reservation or
provider request was created.

Earlier attempts remain separate evidence: one discovery attempt ran zero tests;
the baseline then reproduced the bug. The first candidate combination counted
the component suite twice because a Windows dot-directory path defeated its
backend-project exclusion. Its intended jsdom run passed; the duplicate backend
run failed matcher setup. That combination also exposed the missing explicit CI
suite entry and a fixture lint warning. The final execution fixed root-token
normalization for glob and exclusion patterns, corrected the test/config issues,
and preserved intended project ownership without changing production Jest config.

## Limits and remaining work

Exact membership grows with accepted samples. Storage, read/parse, membership
checks, copying and serialization are O(n); cumulative inclusion writes can
serialize O(n²) bytes. The 14-day eligibility window does not bound cardinality.
Existing recovery limits still apply, including 64 MiB per record and the
aggregate/archive limits. A future scalable representation needs its own design
and acceptance evidence.

The interruption tests establish application-process crash behavior around the
existing atomic replacement. They do not establish fsync or power-loss durability.
Activity compaction's membership preservation was inspected in source rather than
executed in the new process suite. Logical role retirement does not prove physical
worker quiescence.

The overall cloud mission remains open. All four historical paid reservations
remain `retired-meter-pending`, holding the **$100 total cap** with $0 unallocated.
Recorded partial observations are not final spend. Actual Modal model artifacts,
GPU startup, inference, native Flow, independently hosted peer recovery and a
development-speed comparison remain unproven.

## Evidence

Evidence directory: `.factory/flujo-outcome-idempotency-20261003`.

| Record | SHA-256 |
| --- | --- |
| Baseline execution | `180978f1b328a227b6702e75ec0acd2efc5c20013a5bdedca0728760b57cbd6e` |
| Final execution | `b146b8a7039c6ceac5be10ec6e061e068a600ee670532680398d98c6b417ecf5` |
| Lint | `84808d27c174cc68698933462df85944d3957d38dbf8a045ac0a08725e999c84` |
| Type check | `2946f7ffdf8055d2c2ef3ebb777ec298b505e43eaa0df1c4b9931a367298848b` |
| Candidate evidence | `84a525b8a57984fc507355b76a687653dbb0d2f7769ff3df574edad96d63f14d` |
| Submitted candidate | `1bb7ad9b1057f22904b71600cb2ba860ac273172ca8bb27dbf2fd39387b2912d` |
| Independent acceptance | `62b918c9f2ea328a91391f7da53a56db519ac0e3b43f9d9ff0663bc72bd711e6` |
| Executed delivery driver | `2b99fb082bf02b0f3f1b367868dd091eabba23b260fb9d4a9ec1669188577724` |
| Actual delivery/closure | `52951ccaabb598fd98a3e0d5e0885fcda3dad61514a083deb0cbf0d68b883a89` |
| Independent delivery outcome | `14f7be38f06a34c0bfd909da68cfded6a491aebe64e1c37e3ec5d14d5398a776` |
