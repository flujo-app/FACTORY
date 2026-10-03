# Factory qualification record

Updated October 3, 2026. Current runtime source is
`67997585baa897bd7586fe21b9a755c89739a1a3`, adding authenticated read-only Modal
journal observation. Its complete qualified suite passed **270/270** with recorded
exit 0 and unchanged source hashes. The earlier lifecycle/HTTP adoption at
`0948fdd9ff7f5d379982e6e7286fd220236a1993` retains its separate historical
**188/188** isolated-stage qualification. R3 used unchanged launch build `15d6c78`
(whose earlier source suite passed **162/162**) and ended without inference proof.
The original API on port 4343 remains build `6fcd718`; a separate API on port 4344
runs build `6799758` with an explicit Modal journal registry.

## Proven so far

The offline recovery pilot uses real Git, SQLite and separate Node processes. It
records an integration intent, kills the process after the Git mutation and
before its receipt, reopens the coordinator, observes the exact destination,
reconciles the original action and rejects stale ownership. Competing candidates
and integration writers cannot both publish. Evidence:
`evidence/local-recovery-20261002/report.json`.

The live Fly pilot `federation-20261002` passed in **314,235 ms**. A real FLUJO
worker used the selected Codex subscription adapter to produce a small pure
function and a child-review proposal. The local coordinator validated and
provisioned that child; its real model call independently returned the required
review and truth table. A deterministic local verifier accepted the exact source
grammar and evidence. All four provisioning/call effects succeeded and the two
owned retirement effects succeeded. The controller then paused with zero
unresolved effects. Original failure evidence and identities were preserved
through guarded fixture recovery. Evidence:
`.factory/federation-20261002/report-resumed.json` and its controller database.

A separate same-host watcher observed both owned running machines and then both
apps absent from Fly. Its terminal observation at **23:24:10 UTC** reports
`liveRetirementObserved: true`. The watcher is a separate process, not an
independently hosted rescue authority. Evidence:
`.factory/federation-20261002/watch-observations.jsonl`.

The source instance is `b7294be9-caa6-478b-9e0a-bf6f52fb7f57`. The compatible
official worker image is pinned to
`sha256:77776e398f5b9c7216a440dc27753eff7a4df2978930eca37eb32b1ce193c129`,
revision `1282c7e831b701bed841a84dc36d077004bcd354`. Version/protocol compatibility
does not establish equality with the dirty shared local FLUJO checkout. No
generated source was executed on the owner's host, and this was a delegation
connectivity proof rather than a delivered FLUJO repository improvement.

The operator API is live on `127.0.0.1:4343`, build `6fcd718`, serving one configured
factory from read-only SQLite. Actual checks returned 401 without authentication,
200 for authenticated snapshots/events and 405 for writes. It exposes separate
logical allocation and paid admission projections. The brain-online staff BFF
also read this actual endpoint successfully; anonymous access was rejected and
customer access excluded. Its frontend work is
[brain-online PR 34](https://github.com/flujo-app/brain-online/pull/34).
See [the interface contract](C:/Users/Moe/Documents/ChatGPT/FACTORY/BRAIN_ONLINE_INTEGRATION.md).

This snapshot's task/effect/pause scope is the Fly pilot's controller. Modal uses
a separate operation journal and shared paid-admission ledger, without consulting
that controller's pause. The shared paid projection covers both providers; it
does not extend the controller's effect-drain or pause claim to Modal. The paid
gate can fence the next dispatch but cannot itself cancel an already-running
provider operation.

The separate API on `127.0.0.1:4344`, build `6799758`, now exposes registered
Modal journals through an authenticated observation route. Its persisted local
operation records and independent paid-budget projection have their own scope;
neither extends the Fly controller snapshot into Modal execution authority.
The actual witness and source qualification are recorded below. The brain-online
frontend has not opted into this new route, and port 4343 was not changed.

Independent review cleared brain-online build
`b811bbd2dd8f7682e9c5598845c8f23a84badf1d`: **23/23** targeted mounted-host,
avatar and bridge checks passed. Refresh responses denying authorization now
clear prior factory facts and inspection state; changing the authenticated
subject invalidates old profile reads and remounts the factory view. Seven of
the owner's nine mounted-host cases failed against the preceding build and
passed after the fix. This records reviewed source and local validation, not a
merged or deployed PR.

The subsequent brain-online build
`9b1daf9825d38b94b0a5da4ed3ba06b4d9feba4e` labels admission scope and shows the
actual backend build/revision. FACTORY inspected this narrow diff without finding
an authentication, API or schema change. Its 28 checks, typecheck/build and fresh
01:31 UTC actual BFF read are owner-reported; the independent 23-check execution
above belongs to `b811bbd`. No merge or deployment was performed here.

A saved real-Git before/after comparison uses identical specification, candidate,
review, delivery request and destination. An external winner advanced the target
before either trial. Baseline `d70bd69` leaves the completed preflight refusal
unknown and blocks fresh integration ownership; current `27671ca` settles that
genuine refusal as `not_applied` and admits the successor lease. The candidate
remains verified and undelivered, with the same external winner and unchanged
reflog. Safely blocked ownership requests changed **1 → 0**. This is one recovery
case, not an atomic-race experiment or an overall development-speed benchmark;
the single-trial runtimes support no speedup claim. Independently audited evidence:
`.factory/git-refusal-comparison/run-2026-10-03T00-13-58-096Z-602c0ee3`.
Report SHA-256:
`906ab5174b74126ea4619dbcf69c6f35c48d50194b1e8655feef8250d44de55d`.

A real source-pinned FLUJO task, `flow-token-limit-docs` in project
`flujo-api-documentation`, completed independent acceptance and local delivery.
Its isolated branch started from freshly fetched upstream
`d68492712315d30c856c8d2ba95b0a26a859bd18`; candidate
`ea66f1130e01d3208173cd850d40f85f319b3582` has that sole parent and changes only
`src/app/v1/chat/completions/README.md`. It scopes POST/GET HTTP `max_tokens` to
supported direct `model-*` completions, states that Flow requests ignore it,
and explains authored Process-node `maxTokens` then bound-model setting then
adapter default, per supported completion rather than a total Flow/tool budget.
The direct-model and Process-property examples both use 64.

The independent review bound the exact specification, attempt, candidate, diff
and source behavior. JSON and syntax-only example checks passed; no example,
runtime Flow or model generation was executed. A reviewed Git compare-and-swap
delivered the exact candidate to
`refs/heads/codex/factory-reviewed-api-token-limit-docs`, followed by an independent
destination witness. This task's controller is paused at epoch 2 with zero
unresolved effects. The dirty owner checkout and running instance were preserved.
This qualifies one real documentation change through the common local acceptance
and delivery contract; it does not establish a runtime improvement, upstream
publication or development-speed benchmark. No new paid reservation was created.
Delivery report: `.factory/flujo-token-docs-20261003/delivery-report.private.json`,
SHA-256 `8798d6d1485fe08f3cf532588f7a323ddcdf1b9c5caee59bf87fb259636271a8`.
Independent review SHA-256:
`594e5c243d357e0c87ab01930599df7dda3d9c598bd75fc9efd29a3e22bd780f`.
Final independent destination witness SHA-256:
`bf317e511e69343d1d5797ec9ff9ba20eaa4da2b977e6beec0a9ce0f05c68c7c`.

After qualified source adoption, the original `docs-builder` and `docs-reviewer`
leaves were logically retired through the new `retireCell` method. Both had zero
allocation/spent and no provision bindings. Independent audit confirmed exactly
two original `cell_retired` events (sequences 15/16), root logical allocation/spent
zero, controller paused at epoch 2, no open effects and one historical successful
Git delivery. Delivered task attempt 1, specification, candidate, review, file
hashes and producer history remain intact. Paid policy/reservations/events remain
unchanged; the audit matched their coherent digest
`6e93379f0556b78c91845026b828e8db4fc97a3d21896f53eef5551c5a955f80`.
This is logical closure of never-provision-bound cells, not provider retirement
or verified worker quiescence. Protected report:
`.factory/flujo-token-docs-20261003/logical-retirement-report.private.json`, SHA-256
`cc880cb140732000a33017ef742e6663fb7d5edca5c06a02d969ad3677353614`.
The protected independent adoption/closure/paid audit was published at
**02:42:43.346 UTC**:
`.factory/integration-stage/run-2026-10-03T01-49-59-785Z-offline/independent-adoption-closure-paid-audit-88d56140-3690-4057-91ee-86154ca54a24.private.json`,
SHA-256 `fa2c64fcb94e2d9c506fab0453715e12c9237e88981bf1b16d29fcd10abccbe4`.

The complete source suite after build `7691288` passed **147/147 Node test results**,
including policy and fake-SDK checks that invoke 28 Python cases. These cover
cross-process budget/lease contention, crash recovery, Git compare-and-swap,
authenticated sanitized projections, paid admission, unknown-effect preservation
and owned teardown. Evidence: `.factory/tests-owned-stop-and-admission.txt`.

## Paid resources and accounting

The owner authorized **US$100 total** for the paid factory work. One shared
`spending.sqlite` reserves $10 for Fly and $30 for each of three distinct Modal
experiments; **$100 is held and $0 remains unallocated**. Recorded partial
charges total **24 cents**: R1 4, R2 12 and R3 8. All final charge fields remain
null, with final spend unknown. These are conservatively rounded partial
observations, not exact total spend or a strict monetary lower bound. All four
reservations are now `retired-meter-pending`; paid revision 17 retains the full
10,000-cent hold and zero unallocated cents. Holds are not charges.
Each new paid dispatch rechecks admission. Known local experiment/global
exhaustion blocks further paid dispatch, while owned cleanup remains permitted.
Reservation retirement does not free its ceiling before final billing evidence.
Cell allocations, reservations, estimated compute and actual charges are distinct.

Final invoices are not yet reconciled. An independent **00:45 UTC, October 3**
billing query found one completed hourly row for the first Modal attempt's exact
App: **US$0.03503811**, attributed to CPU and Memory. Function/Volume-only
selection had omitted this available App row. Independent file/source identity
review confirmed its original App/profile/workspace/environment binding. The
ledger now records **4 cents**, rounded upward for conservative admission,
as a partial observation; final metered spend remains null, with the full $30
hold unchanged. Provider report cutoff and local ingestion time are preserved
separately. Evidence SHA-256:
`b82061b272392d724c89fe264740453fd4af014ca26ad40d3aabb79be12230b7`.
The committed meter fix adds exact recorded App eligibility and refuses ambiguous
parent/child compute overlap rather than summing an unproven total.

R2's local SDK observation reached its **4200-second** bound at **01:09:55 UTC**
without confirming complete weights. Its original prefetch stays unknown with
the original request digest; no generation, proxy token or native model/Flow was
created. The original App stop succeeded with zero containers, and the original
Volume deletion succeeded. A separate provider witness at **01:10:57 UTC**
confirmed stopped/zero, active App lookup absent, and exact Volume absence from
complete inventory and noncreating lookup. Its full $30 hold is
`retired-meter-pending`. Completed-hour App billing through **01:00 UTC exclusive**
reports another **US$0.11033673**, recorded as **12 cents** conservatively rounded
up. At that point the combined recorded observations were **16 cents**, with final
spend still null. This excludes R2's last partial hour and remaining charges.
Evidence SHA-256:
`ac5267638c43c92fa2b9fb4b22f4925bb76ee03324cf719104004b06452223b3`.

After that terminal cleanup, the independently reviewed version-2/acceptance/
result-retrieval/billing patch was applied. The merged checkout passed the complete
**162/162 Node test results**; its focused qualification was independently
**33/33**, including 46 Python cases. Evidence:
`.factory/tests-v2-qualified.txt` and the isolated stage's immutable test report.
The patch was committed as `15d6c78`. A fresh R3 experiment started its original
prefetch at **01:19:27.510 UTC**, with distinct App/Volume/effect/reservation
identities and the remaining $30 hold. An independent read-only witness at
**01:21:03 UTC** confirmed the exact deployed App, one CPU prefetch runner/input,
zero inference runners/inputs and the exact Volume's filesystem version 2.
Evidence SHA-256:
`81bdf5036b68fbf0906a894bbba571fd82b0e9618c69f0d858ff824c3db895e5`.
Independent local inspection bound all six unchanged runtime source files,
original request digests and the saved Flow's actual Process `maxTokens: 64`.
Download completion, performance improvement and actual inference remain
unproven; file-count observations and offline checks establish none of those.

A fresh independent witness at **01:49:22–23 UTC** again found R3's exact App
deployed with one CPU runner/running input and zero inference runners/inputs.
Its owned Volume still existed with filesystem version 2. The original local
journal still had only successful create/deploy and a running prefetch.
Evidence SHA-256:
`eb1d16486f15670cc2eddc3519425080fb073a06669f3bcdb175f0a0f8d95f5e`.

Historical provider diagnostics inspected after R2's retirement show failed
worker heartbeats and a container killed by **SIGKILL, exit 137** at
**00:28:28.930 UTC**, with a provider memory warning. This strengthens memory
pressure as a hypothesis; it does not establish a kernel OOM event or the cause.
The original uncertain prefetch receipt remains unchanged. Provider container
attempts do not establish coordinator replay. Immutable transcribed UI evidence
SHA-256:
`7f5da7362723c9a4a8f7f527d9eae2cc15c494d4d1b5edc3cd4675b884b68333`.

R3's image enables `HF_XET_HIGH_PERFORMANCE` on a 2 GiB CPU downloader. Current
Hugging Face documentation describes that mode for machines with at least 64 GB
RAM and warns that smaller systems may perform worse. This is a concrete
configuration mismatch and a diagnostic lead, not proven causality. Two rounded
historical dashboard samples at 01:22 and 01:26 UTC showed about 1.8 GiB RAM and
1.8 CPU cores used, with low network ingress. Those samples establish neither
download completion nor a general stall. The running R3 image was not altered.
[Hugging Face Xet documentation](https://github.com/huggingface/hub-docs/blob/main/docs/hub/xet/using-xet-storage.md).
Dashboard transcription SHA-256:
`92836e5ded49d09628f6f88cf583e2b60e0ae8c0e4a06db8cf909e1e1cb02f08`.

Later rendered provider history showed R3's first container failed at
**01:43:30.358 UTC** with **Runner heartbeat timeout: 900 seconds**, after failed
heartbeats and a provider cancellation request. A replacement container started
at **01:43:33 UTC** and was live at the subsequent inspection. The original
coordinator prefetch remained running; no coordinator retry was issued. The
recorded reason is heartbeat timeout, with its underlying cause unproven.
Modal documents prolonged GIL holding and incomplete process shutdown as typical
application causes; neither is established here. This is separate from R2's
SIGKILL/137 evidence. [Modal heartbeat documentation](https://modal.com/docs/guide/troubleshooting#heartbeat-timeout).
The immutable rendered-UI transcription was captured at **01:51:53.904 UTC**;
its displayed observation minute is approximate. Evidence SHA-256:
`a8152dd4cdfdc0976b12468e6b89dd7124560821a4bbb37b3e6a432a0d242fdd`.

A later immutable rendered-UI note, captured at **02:20:59.288 UTC**, records R3's
second container failing at **02:13:25.993 UTC** with another **900-second runner
heartbeat timeout**. Its third container records **SIGKILL, exit 137** at
**02:14:15.473 UTC**, with the provider's memory warning. A fourth container
started at **02:14:19 UTC** and was live at the displayed 02:20 observation minute.
The original first note is preserved. These are provider container replacements,
not evidence of coordinator replay. Neither the warning nor exit 137 establishes
a kernel OOM event, underlying cause, complete shard or successful inference.
The original local driver remained live at this observation on unchanged build
`15d6c78`, approaching its original approximately **02:29:27 UTC** bridge deadline.
Evidence: `.factory/modal-20261002-r3/observer-later-container-failures.private.json`,
SHA-256 `2c597f3864118d8d2443547761acf8a240b66a33176f2fa44c083adc3beed450`.

R3's completed-hour owned-App billing observation at **02:09:02.300 UTC** covers
**[01:00, 02:00) UTC** and reports **US$0.07357657**. The local coordinator ingested
that same bound proof at **02:14 UTC** as **8 cents**, rounded upward. This nonfinal
observation is not the charge for the whole running experiment. The full $30 R3 hold remains
unchanged. Together with R1 and R2 this records **24 cents in conservatively rounded partial observations**, while
all $100 remains held and final spend remains null. Provider cutoff, observation
time and local ingestion are distinct. Evidence SHA-256:
`c28a3c1892ebfac7e3e432b6dbf0ff152eb6b087ba520a894075d4c19b94c4eb`.

R3's original bridge reached its bound at **02:29:27.667 UTC**, retaining the
original prefetch as unknown. The original `stop-app` succeeded around
**02:30:16 UTC** with explicit zero containers; the original owned Volume deletion
succeeded at **02:30:24 UTC**. The driver ended with exit 1 and
`requires-reconciliation`, without inference success. A fresh actual provider
witness between **02:30:48.157 and 02:31:11.303 UTC** confirmed the exact App
stopped/zero, active App lookup absent, and owned Volume ID and name absent.
Provider witness SHA-256:
`fd6ab7dc2aea725d91a9e6eca11cd85d0a562468e41f020542743c1bc903e9ac`.

The original-operation audit matched all six old source hashes and five exact
intents, preserving the unknown prefetch. No proxy-token creation, direct
generation, native model or Flow operation was admitted. Physical cleanup does
not turn that unknown download into a confirmed success or failure. Audit SHA-256:
`45f337c7c84e4badd637af5d2d0a889f991bcd4acbc56a2727f7792923212320`.
Original report SHA-256:
`b5e1252767f700ba155c53ceaece2cd5befdd67c6119cffe186d42820a4aacf8`.
Retirement report SHA-256:
`57fde4e0fc8dd7fcbacb68f8fb275cfb8fc76d38fb67f71fb29af06efd0bc94b`.
R3 now joins the other three reservations in `retired-meter-pending`, retaining
its full $30 hold. No new paid attempt is admitted and no HTTP-variant cloud
execution follows from source adoption.

The O owner separately reports two deliberately launched O runs, each with a
127-cent reservation and confirmed cleanup of its model/tools sandboxes. Their
254 cents remain held pending billing; observed and final charges are unavailable.
These are owner-reported O operations under separately reported human approval,
not reservations or resources adopted by this FACTORY ledger. The $100 figures
above retain their registered-FACTORY scope.

The ledger is local
admission/accounting for registered factory reservations; it is not a provider
hard billing stop or an audit of unrelated account usage. The Fly apps have been
removed. Independently audited retirement moved its reservation to
`retired-meter-pending` while retaining all $10. The first Modal attempt did not
complete. Its 900-second CPU weight prefetch timed out, and direct generation and
actual FLUJO Flow execution were never dispatched. The $30 reservation remains
held. Original unknown-operation evidence is retained rather than replayed.

The first Modal App and owned weights Volume were created. Independent control-plane
observations matched the recorded App/Function identities. After the one stop
command, the immediate inventory still showed a stopping App with one container;
the stop receipt remained unknown. A fresh independent observation at
**23:45:47 UTC** confirmed that exact App was stopped with zero containers.
The original stop was then positively reconciled with fresh bound evidence, and
the first separately journaled delete removed its owned Volume. A further
independent provider observation at **23:56:36 UTC** confirms stopped/zero,
active App lookup absent and owned Volume absent. The original unknown prefetch
and initial failure reports remain unchanged; its $30 reservation is now
`retired-meter-pending` with its full hold. No proxy token or native Modal
model/Flow fixture was created. An observed CLI compatibility correction
was committed as `cc3e017`: actual SDK1.5.5 JSON uses snake_case lifecycle fields,
rather than human display labels. Its strict parser requires explicit matching
identity/state/container count and rejects ambiguous/conflicting fields. Focused
validation passed 14 Node results invoking 23 Python cases. The per-operation
bridge update is recorded separately in the private run's runtime-update proof;
the deployed model/config and admitted requests were unchanged.

Build `d70bd69` additionally forces UTF-8 only for child CLI capture on Windows.
Build `9b232ec` introduces a dedicated local Git delivery gateway: a genuine,
completed compare-and-swap refusal can settle as `not_applied`, while killed,
timed-out or unproven attempts remain unknown. It does not authorize automatic
rebasing or claim delivery of a refused candidate. Focused checks passed 36/36.

Build `7691288` adds durable original-stop reconciliation and bounded read-only
terminal polling after one stop command. It also exposes trusted-local
`pauseAdmission()` and `resumeAdmission()` on the paid ledger, compatible with
O's existing markers. Pause fences fresh and replayed reserve/start transactions;
it leaves accounting and owned cleanup available. Already-authorized external
work may still finish. Existing lower budgets are preserved by both pilot
drivers rather than reset to the default experiment budget.

A fresh Modal attempt `modal-20261002-r2` began at build `5b73656`, using distinct
App/Volume/operation/reservation identities. The same pinned model and transport
are used, with a 3600-second CPU prefetch and a derived 4200-second local bridge
bound. Focused offline validation passed 19/19. Its deployment completed in
10,232 ms. An independent provider observation at **00:00:41 UTC, October 3**
confirmed one prefetch runner/input and zero inference runners/inputs. This
establishes its actual running CPU stage, not completed weights or inference.

An identity-bound read-only observation at **00:18:11 UTC** confirmed that R2's
weights Volume uses filesystem version 1. Version 1's random-write overhead is
a plausible performance lead for this parallel download, not a demonstrated
cause. Modal documents improved random access in version 2 and considers
rebuildable model caches suitable for its beta; the isolated version-2 variant
was independently qualified and used for the fresh R3 experiment after R2
retired. [Modal volume documentation](https://modal.com/docs/guide/volumes).
File counts and a timed-out log observation do not prove download completion,
failure or byte progress. No direct model call or native Modal-backed FLUJO Flow
has yet been proven.

Read-only inspection of the running compiled FLUJO adapter also found that the
Flow path does not forward HTTP `max_tokens` into its Process node. R2's authored
fixture requested 64 tokens over HTTP but would have used its configured
model/server output bound of 1024. That Flow was never created or invoked.
The committed R3 fixture puts 64 directly on the node and binds its exact
digest. Stricter smoke acceptance requires one assistant choice, a normal
stop, no tool/function calls, the expected returned model and the exact ready
object. The driver's own success alone is insufficient; raw response and
identity-bound receipts require independent review.

## Adopted source qualification

Two compatible follow-ups passed isolated review and were applied only after
R3's original run ended and owned retirement was witnessed. The lifecycle patch supports task
release and retirement only for never-provision-bound leaves, preserving reviewed
work and paid holds. Its author passed 76 affected checks; an independent reviewer
passed 32 lifecycle/adversarial cases. Patch SHA-256:
`d0e4f42520a4ef122b3c4f67527a139b16a7e158b6503de3f45cf49150513364`.

The low-memory HTTP variant disables Xet and HF Transfer before Hub import, uses
one download worker, sends no cached Hugging Face token, and verifies the pinned
Hub version and actual private download metadata. It retains the same resources,
timeouts, model revision, inference acceptance, cleanup and billing contracts.
Independent validation passed 35 focused Node checks and nine socket-blocked
probes against actual official Hub 0.36.0 source. The Node checks invoke 54 Python
test methods; a separate focused Python execution covers 44 of those. Corrected
inventory metadata did not change source or rerun tests. This is offline
qualification, not demonstrated cloud throughput, peak memory or download success.
Patch SHA-256:
`fb982f97eef5986781c34e222f882fa9fbe72fc464dad44ca4bb981a3ccf7f3a`.
Independent report SHA-256:
`eddbafc221ad2f0e5444f289a9289d04a6858f0710e999d6ad26efba08cbbd16`.
The full allowance remains held; adopting either patch does not admit another
paid experiment. Combined isolated qualification passed **188/188 Node results**,
exit 0, with no skipped or cancelled tests. A pre-test preload setup failure is
preserved separately. A subsequent non-rerunning independent audit verified the
two exact input patches, the 11 changed files, saved TAP/execution result, and all
47 staged source hashes. Source differences from the individual stages are only
CRLF-to-LF normalization; unchanged shared files retain their original raw hashes.
Combined patch SHA-256:
`d7620687dc89d2853eeec59487ddb3aedf93b098aeded9e2caba9ed052337544`.
Artifact manifest SHA-256:
`1eaa7fed6bf592e423c41a88cd77bb1fa3d3f11a02c769578653e3cddf86f897`.
Adoption commit `0948fdd9ff7f5d379982e6e7286fd220236a1993` contains those exact
11 reviewed files. Root's post-adoption proof and independent validation at that time
matched the 47 qualified stage files and 44 compared shared source files after
line-ending normalization. That adoption did not rerun the shared suite or change
extra runtime source. Post-adoption proof:
`.factory/integration-stage/run-2026-10-03T01-49-59-785Z-offline/root-adoption-byte-verification.private.json`,
SHA-256 `18e404b495883689e8d7f0b9d9370f76512b4c253a1bbe751491fa7eec2e0416`.
The corrected source-bound logical-closure wrapper SHA-256 is
`3bf44c228d2abe34cfff12185de7cfa5ca5a3a69a5e4658c2f5374e73a6084e9`;
it executed the documented local closure after validation. The low-memory HTTP
path has not been cloud executed, and its performance is not proven.

An authenticated local API witness at **02:38:50 UTC** confirms process build
`6fcd718592ebf86b2d546f0eaab2cb5b159a4140`, schema 1, Fly-controller revision 89,
paused admission and `commands: false`. The independent paid revision is 17:
four retired-meter-pending reservations, 10,000 held cents, zero unallocated,
24 conservatively rounded partial cents, final spend null and billing incomplete.
That port 4343 process still exposes only the Fly execution controller; the
separate Modal and documentation journals are absent from its snapshot. Its
process and snapshot/events contract were left unchanged when port 4344 started.
Protected API witness SHA-256:
`783750aa183be89c5295f87e6db00e9ccfec8ee11eb102fd5080e268ef0a427b`.

## Modal journal observation qualification

Source commit `67997585baa897bd7586fe21b9a755c89739a1a3` changes eight files for
the sanitized reader, owner-private configuration, CLI, authenticated
routes, tests and observation contract. The complete qualified suite ran on
Node **24.19.0** from **03:03:58.026 to 03:04:15.886 UTC**, with explicit
`--test-reporter=tap`: **270/270** passed, process exit 0, no failures, cancellations,
skips or todos. All 45 recorded source files were unchanged before and after the
execution. Qualification proof:
`.factory/qualification/modal-observation-a54f8ad9-72d9-4958-8e28-35d5bbc3c2df/combined-qualification.private.json`,
SHA-256 `e153fe33e5eda429724bc71c2a8802ae6c45419b8b58cf3674c2158b8de68e1d`.
Saved TAP SHA-256:
`dd86a68c945da941a9438a8cf39b339611169fd819081c420f6470b4f3aaa0bc`.

An earlier execution's default spec output reported 270 passing checks, but its
recorder failed after execution while expecting TAP, before persisting child exit
and source inventory evidence. The source, raw output and private failure note
were preserved; no product source changed. A justified repeat with the corrected
recorder captured the complete evidence above. This new qualification was not a
single execution, and it does not borrow the historical 188-test result.
Preserved recorder-failure note SHA-256:
`dee150fb46f0a84de4d69a81f523acca85574a907bf039d3582d3346f5f7989f`.

A fresh authenticated HTTP witness at **03:05:45.936–03:05:46.130 UTC** checked
the separately started `127.0.0.1:4344` API, reporting full build
`67997585baa897bd7586fe21b9a755c89739a1a3` and factory ID `factory-live-pilot`.
Both `/v1/modal-runs` and the factory-scoped route returned 200, exposing exactly
three registered runs and 15 historical operation records. All three prefetch
records remained unknown. The existing snapshot contract returned 200;
unauthenticated access returned 401, POST 405, query parameters 400 and a wrong
factory ID 404. Observed database logical states and main/WAL bytes were unchanged
throughout the witness, which made zero provider calls. Protected witness:
`.factory/viewer/modal-observation-witnesses/modal-api-211f3c38-0494-4146-b443-6524f63900a8.evidence.private.json`,
SHA-256 `d73219e9fe4ee2566c2799f5f6856dec2986dced67fdbfe3a65cf53d0b22acb1`.

An independent adoption audit completed at **03:08:59.554 UTC**. It verified all
45 current raw and committed normalized source files against the qualification,
the exact eight-file adoption, saved execution/TAP records, and one additional
authenticated local API read. Every run contains exactly `create-volume`,
`deploy`, `prefetch`, `stop-app` and `delete-volume`; unknown outcomes, logical
records, main/WAL bytes and paid accounting remained unchanged. It did not rerun
tests or call a provider. Protected independent audit SHA-256:
`bd181bd348cf430d2c93e244df9784628a1c126eac4a6dffbc65694a232be38b`.

This route explicitly reports `registered-modal-operation-journals` scope,
`persisted-local-operation-journal` basis and provider freshness `not_observed`.
Its content-SHA journal revisions are separate from the controller cursor and the
numeric paid revision. Response read time does not establish fresh provider state.
Successful historical cleanup records do not resolve unknown prefetch, prove
current account-wide absence or establish inference/native FLUJO Flow success.
The original port 4343 process remains build `6fcd718` and Fly-scoped; no frontend
opt-in, new model call, speed measurement or additional paid attempt occurred.

The witness's shared paid revision 17 reports four `retired-meter-pending`
reservations, 10,000 held cents, zero unallocated cents, 24 conservatively rounded
partial cents, final spend null and billing incomplete. Journal visibility and
successful cleanup do not release those holds or establish final billing. The
broader remaining proofs below stay unresolved.

## Remaining proofs

- Native remote peer enrollment, autonomous child provisioning and authenticated
  peer communication. The successful child request was coordinator-mediated.
- Independently hosted recovery and cross-host delivery ownership; a same-host
  watcher cannot recover from loss of the host itself.
- A runtime FLUJO improvement through source-pinned acceptance and delivery, plus
  upstream publication. The completed one-file documentation task qualifies local
  delivery, with no PR, push, upstream merge or runtime change.
- Operational completion/cancellation and provider-bound task/cell closure across
  control epochs, with truthful resource and billing status. Initial task release,
  never-provision-bound leaf retirement and reviewed-work preservation are implemented.
- Modal-backed direct inference and actual native FLUJO Flow execution. Offline
  HTTP download qualification does not establish either.
- Measured self-improvement: comparable baseline/candidate delivery outcomes,
  protected evaluations, explicit activation and rollback. More workers or a
  successful model request do not establish improved development speed.

The [lifecycle document](LIFECYCLE.md) distinguishes the implemented initial
subset—task release, never-provision-bound leaf retirement, ready-cell authority,
causal guards and allocation conservation—from the broader proposal. Provider-bound
retirement and additional completed/cancelled task states remain proposed and
require qualified resource evidence and coordinated strict interface changes.

The shared FLUJO source, owner default-model binding, paused hackathon automations
and unrelated cloud resources were not reset or resumed by these experiments.
