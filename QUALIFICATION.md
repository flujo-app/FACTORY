# Factory qualification record

Updated October 3, 2026. Local trusted coordinator; live Modal R3 launch build
`15d6c78`, with the merged source suite passing **162/162**. The operator API
continues to run its separately reported build `6fcd718`.

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

The complete source suite after build `7691288` passed **147/147 Node test results**,
including policy and fake-SDK checks that invoke 28 Python cases. These cover
cross-process budget/lease contention, crash recovery, Git compare-and-swap,
authenticated sanitized projections, paid admission, unknown-effect preservation
and owned teardown. Evidence: `.factory/tests-owned-stop-and-admission.txt`.

## Paid resources and accounting

The owner authorized **US$100 total** for the paid factory work. One shared
`spending.sqlite` reserves $10 for Fly and $30 for each of three distinct Modal
experiments; **$100 is held and $0 remains unallocated**. Recorded partial
charges total **16 cents**, with final spend unknown. Holds are not charges.
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
up. The ledger's combined recorded observations are now **16 cents**, with final
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

## Remaining proofs

Two compatible follow-ups have passed isolated review but are not yet applied to
the shared runtime while R3 runs. The logical lifecycle patch supports task
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
The full allowance remains held; preparing either patch does not admit another
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
This tested source remains isolated while the original R3 runtime is active.

- Native remote peer enrollment, autonomous child provisioning and authenticated
  peer communication. The successful child request was coordinator-mediated.
- Independently hosted recovery and cross-host delivery ownership; a same-host
  watcher cannot recover from loss of the host itself.
- A real source-pinned FLUJO improvement delivered from isolated branches through
  the common acceptance and integration contract.
- Persistent task/cell lifecycle and verified-candidate handoff across control
  epochs, with truthful resource and billing status.
- Measured self-improvement: comparable baseline/candidate delivery outcomes,
  protected evaluations, explicit activation and rollback. More workers or a
  successful model request do not establish improved development speed.

The independently reviewed [lifecycle proposal](LIFECYCLE.md) describes the next
compatible patch: logical leaf retirement and task release, ready-cell authority
checks, causal effect guards and exact allocation conservation. It preserves
reviewed work and paid billing holds. It is a proposal rather than an implemented
closure API; additional completed/cancelled task states first require coordinated
strict interface-contract changes.

The shared FLUJO source, owner default-model binding, paused hackathon automations
and unrelated cloud resources were not reset or resumed by these experiments.
