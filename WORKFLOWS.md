# Verified workflows

`flujo-factory/workflows` adds an artifact-centered lifecycle to the existing controller:

```
implement → frozen candidate → independent review + objective gates
                   ↑                    ↓                 ↓
                 revise ← revision_required           accepted → delivered
```

There is no implicit maximum run duration. `accepted` means independent review
approved the candidate and every declared gate passed; an explicit review-only
policy makes no objective verification claim. `delivered` still requires the existing integration lease and delivery
effect receipt. Agent-authored PR progress grants neither state.

## Generic teams and integrated delivery

FACTORY supports research, documents, data analysis, operations and other tasks
without a repository. Git is an optional source adapter. A cloud plan can omit
`repository` and `repositoryRevision`; it then needs no GitHub credential and
creates ordinary per-agent workspaces. With `workflow: 'verified-v1'`, each team
has one coordinator, one independent reviewer (its last worker), and the remaining
workers produce deliverables. Five agents means one coordinator, three producers
and one reviewer. No additional reviewer machine or model call is created.

The coordinator retains the original problem and acceptance as a parent task,
delegates child tasks and integrates their accepted outputs. A parent cannot be
submitted while child work remains unaccepted. Its frozen candidate binds the
accepted child candidate references; the final integrated deliverable receives
its own independent review. Child completion wakes the integration owner.

The recommended agent operations are:

* `factory_assign`: task ID, assignee, original problem/acceptance, optional parent
  and dependencies, plus an explicit verification policy. The SDK selects the
  team's sole reviewer. Review-only acceptance requires a reason; objective mode
  requires declared executable gates.
* `factory_submit_workspace`: selected relative paths, task ID, stable submission
  ID and summary. The local MCP freezes bytes, uploads missing work across retries,
  renews the claim and submits the same candidate. Use a new submission ID for edits.
* `factory_candidate_files`: list or read bounded ranges of the immutable files.
* `factory_review`: exact candidate ID, boolean verdict, rationale and any findings.

Review, executable verification and permission to publish remain separate. An
unavailable verifier leaves its gate open and does not prevent unrelated tasks
from progressing. A review-only decision is never reported as an objective pass.

```js
import { Factory } from 'flujo-factory';
import { FactoryWorkflow, captureWorkspace } from 'flujo-factory/workflows';

const database = '/private/research/control.sqlite';
new Factory(database).createSwarm({ mission: 'Summarize the evidence', agents: [
  { id: 'researcher' }, { id: 'analyst' }, { id: 'writer' },
  { id: 'reviewer', role: 'verifier' },
] });
const workflow = new FactoryWorkflow(database);
try {
  workflow.createTask({ taskId: 'report', assignee: 'writer', reviewerId: 'reviewer',
    problem: 'Explain the findings with traceable sources.',
    acceptance: 'Claims cite sources and distinguish evidence from uncertainty.',
    verificationPolicy: { mode: 'review-only', reason: 'Requires source evaluation and judgment.' },
  });
  workflow.claim('report', 'writer');
  const frozen = captureWorkspace(workflow.artifacts, '/private/report', {
    paths: ['report.md', 'sources.json'],
  });
  workflow.submit('report', 'writer', {
    submissionId: 'report-v1', source: frozen.source, artifacts: frozen.artifacts,
    summary: 'Report and source register for independent review.',
  });
} finally { workflow.close(); }
```

Workspace snapshots preserve files, empty directories and portable executable
modes using 256 KiB content-addressed chunks. They do not buffer an entire source
archive or inherit the legacy Git adapter's 128 MiB archive cap. Symbolic links
are rejected rather than traversed. The manifest records exclusions; default
candidate exclusions are `.git` and `node_modules`. Keep secrets outside selected
deliverables. Individual manifest metadata is limited to 64 MiB by the archive
receiver; partition extremely large inventories into named roots.

`submitWorkspaceCandidate` is the equivalent local/remote SDK helper. Its private
journal preserves the frozen submission across interrupted uploads and unknown
acknowledgements. `createWorkflowClient` exposes `assignTask`, `review` and
`candidateFiles`. Generic executable checks use isolated materialized snapshots,
with byte comparisons before and after execution, and need no repository mapping.
Gates may declare relative `writablePaths` for generated output or dependency
directories. They cannot overlap reviewed inputs; undeclared changes fail the check.

## Continuous evidence and verified shutdown

`startEvidenceServer` provides an authenticated archive receiver. Run it on durable
storage independent of worker volumes, behind HTTPS for remote connections (or
on the private network). Credentials bind one run and one machine; teams in the
same run deduplicate and can read common objects. Different runs have isolated
stores. A `PUT` verifies the content hash and is idempotent. Checkpoint sequence
IDs bind immutable manifests and survive lost acknowledgements. The receiver
rechecks every referenced object before acknowledging a checkpoint and when a
supervisor reads the latest receipt. A receipt covers the configured storage;
the operator is responsible for its durability and backup policy.

`factory-evidence serve private-archive-config.json` runs this service. Its config
contains `{directory, host, port, tokens:[{runId,machineId,token}]}`. Use unique
strong credentials and keep the file private. No cloud resource is created by
this command.

Configure a fleet with:

```js
const plan = {
  runId: 'research-one', app: 'research-one', goal: 'Research the original question',
  machines: 5, agentsPerMachine: 5, workflow: 'verified-v1',
  model: 'gpt-6-luna', subagentModel: 'gpt-6-luna', reasoningEffort: 'xhigh',
  collection: { url: 'https://your-private-archive.example', intervalMs: 60000 },
  // Optional. Omit for an open-ended swarm; there is no default deadline.
  shutdown: { deadlineUtc: '2030-01-01T18:00:00Z' },
};
await fleet.deploy(plan, { image, bundlePath, evidenceTokens });
await fleet.supervise();
```

`evidenceTokens` maps `m0` through `m4` to receiver credentials. They are stored
privately, outside the public plan. Deployment verifies their scope before worker
provisioning. Collection runs in a separate process on each worker machine,
capturing workspaces, original native session histories, `/data/results`, runtime
records and consistent online SQLite backups. Common dependency/build caches and
`.git` are excluded from this continuous export; working file bytes and uncommitted
outputs remain included. Use the existing full archive collector when Git history
itself is required. Collector data is stored separately under `/data/factory-evidence`.

Periodic scans reuse unchanged file metadata and transfer only missing immutable
chunks. Final scans re-read files. Removed/renamed paths disappear from the latest
manifest while earlier checkpoints remain available. A changing file postpones
the checkpoint instead of acknowledging a mixed capture. Files across a live
checkpoint can represent different instants; final capture starts after all
native agents on that machine have proved stopped. Applications that modify
files independently of those agents need their own quiescence policy.
After acknowledgement, the cloud collector prunes superseded local chunks and
SQLite staging copies through FLUJO Bash MCP. Current/pending checkpoint bytes
remain local. Cleanup failures retain data and are reported in
`/data/factory-evidence-status.json`; archive history remains available remotely.
Local collectors expose `pruneAcknowledged` with an explicit cleanup adapter.

Final checkpoints require every original session's nonempty transcript reference
and stop command identity. `fleet.verifiedShutdown()` verifies those identities
against authoritative native stop receipts, reads verified archive receipts,
checks provider ownership, stops the owned machines and confirms their stopped
state. `retire:true` additionally retires volumes only after those checks.
Ordinary `quiesce()` remains resumable. Final shutdown explicitly seals the run
after stop proof; the coordinator then rejects new work commands, and restarted
runtimes resume collection without relaunching model work. An explicit deadline
also causes each machine to finalize its stopped sessions.
Upload failure retains the pending checkpoint and original volumes; retry the
same shutdown operation. A sealed runtime cannot restart model work on recovery.

Run `fleet.supervise()` or `factory-evidence supervise private-fleet-config.json`
on a durable supervisor host. It maintains observations/auth refresh and invokes
verified shutdown at the configured deadline; SDK callers can instead supply a
completion predicate or abort signal. Fleet config contains `directory`, optional
`authFile`/`flujoCloudPath`, and shutdown `options`. The machine runtime also stops
model work at an explicit deadline if the host disconnects; provider shutdown
still requires the supervisor to be running or resumed. Collection and provider
shutdown are separate from stopping model turns. No timing guarantee is asserted
before a real deployment is measured.

`ContinuousEvidenceCollector` also works independently of cloud machines, with
explicit named roots and a session-evidence callback. `restoreEvidenceCheckpoint`
downloads and checks the chosen checkpoint into a new directory without Git.
`factory-evidence shutdown private-fleet-config.json` resumes the shutdown path
for an existing fleet. Legacy `collect()` remains an explicit full-archive fallback.

## Local SDK

```js
import { Factory } from 'flujo-factory';
import { FactoryWorkflow, captureGitSource, runVerification } from 'flujo-factory/workflows';

const database = '/private/run/control.sqlite';
new Factory(database).createSwarm({ mission: 'Repair the parser',
  agents: [{ id: 'builder' }, { id: 'reviewer', role: 'verifier' }] });
const workflow = new FactoryWorkflow(database);
try {
  workflow.createTask({
    taskId: 'parser', projectId: 'application', branch: 'codex/parser',
    problem: 'Preserve documented parser behavior while fixing issue 42.',
    acceptance: 'Existing cases and the reported failing case pass; independent review accepts the change.',
    baseline: baselineCommit, assignee: 'builder', reviewerId: 'reviewer',
    gates: [{ id: 'tests', command: '$node', args: ['--test', '--test-reporter=tap', 'test/parser.test.mjs'],
      adapter: 'node-tap', scope: 'development' }],
  });
  workflow.claim('parser', 'builder');
  // Commit the candidate first; use an absolute checkout path.
  const frozen = captureGitSource(workflow.artifacts, candidateCheckout,
    { repository: 'owner/application', baseline: baselineCommit });
  const candidate = workflow.submit('parser', 'builder', {
    submissionId: 'parser-round-1', source: frozen.source,
    artifacts: [frozen.artifact, ...(frozen.bundle ? [frozen.bundle] : [])],
    summary: 'Handle the reported input without changing valid cases.',
  });
  const packet = workflow.reviewPacket(candidate.id);
  // Give the packet to the separate reviewer, without the implementer's conversation.
  await runVerification(workflow, { runId: 'parser-round-1-tests',
    candidateId: candidate.id, gateId: 'tests', cwd: candidateCheckout });
  // Call only after the independent reviewer returns this verdict.
  workflow.review(candidate.id, 'reviewer', {
    accepted: true, findings: [], rationale: 'Original requirements and edge cases are covered.',
  });
} finally { workflow.close(); }
```

A rejected review includes stable findings `{id, requirement, description}`.
Call `revise`, claim again, and submit another candidate with `resolvedFindings`.
That field records the implementer's disposition; the reviewer independently
checks the repair. Candidate history, original requirements, findings and
diagnostics survive restarts. Tasks freeze their assignments and dependencies.
Create dependencies before dependents; cross-project dependencies support
integration work, and `parentTask` records delegation.

Renew a lease by calling `claim` again as its assigned actor. Pause/resume revokes
the previous lease, so claim again before submitting. Unknown outcomes never
grant acceptance.

## Verification

Gates declare command/argv, parser, scope and an optional command timeout.
`$node` selects the runner's Node binary. `node-tap` requires complete passing
counts without failures, cancellations or skipped tests. `json-summary` accepts
a complete Jest-style summary. Use `exit-code` for compilers/linters whose exit
status is their authoritative outcome, not to conceal test failures.

For Git candidates, the checkout must match the frozen commit, tree and portable `git-archive`, and
remain clean before and after the check. The archive must contain every tracked
blob unchanged. Capture rejects source
hidden or rewritten by `export-ignore`/`export-subst`, and unresolved submodules.
Archive permissions are deterministic. The runner checks actual checkout bytes,
file/symlink types and, on POSIX, executable modes against that reviewed tree
before and after the gate. Windows does not expose POSIX executable mode bits.
Include required dependency preparation
in the declared gate command. The service does not invent installation or release
steps. Development gates are the default; publication, release and live checks
require explicit trusted supervisor policy.

`startVerification` launches a separate durable runner; `reconcileVerification`
reads its authenticated receipt. Reusing the same run ID reconciles the original
execution without repeating it. Missing evidence is `unknown`. A later
authoritative result can resolve that same unknown run while retaining its prior
evidence. A final failed result requires another candidate/attempt.

Commands receive a minimal environment without provider/bootstrap credentials
and a private home. The SDK, CLI, operator credential, verifier service and their
files are trusted control-plane surfaces. They are not a sandbox against hostile
code with access to the same OS account. Use an isolated verifier host/container
and repository-scoped credentials for untrusted work.

## Cloud and supervisor APIs

Set `workflow: 'verified-v1'` in a cloud plan. The last worker on each machine is
the independent verifier; the lead coordinates and other workers implement.
At least three agents per machine are required. Omitting this profile retains
the original coordination behavior.

Authenticated workers use `factory_workflow`, `factory_artifact`,
`factory_workflow_events`, `factory_knowledge` and `factory_workflow_templates`.
Their credential binds their identity. Only the operator can import objective
verification results. Operator imports are trusted assertions; the authority does
not independently authenticate a remote runner's HMAC. Keep operator credentials
inside the trusted verifier service. Worker credentials cannot import results.
The public `createWorkflowClient({url,token,operator:true})` exposes
task inspection/assignment, review packets, artifact transfers, pause/resume,
verification import and stable-ID commands. Ambiguous HTTP delivery is
`OUTCOME_UNKNOWN`: reconcile the original operation identity.

```js
const service = new FactoryWorkflowSupervisor({
  client: operatorClient, directory: '/private/run/verifier',
  repositories: { 'owner/application': '/private/source/application' },
  allowedScopes: ['development'],
});
await service.serve({ signal: abortController.signal });
```

The service retrieves frozen artifacts, checks out the exact candidate in a
private directory, executes declared gates and returns diagnostics. It never
calls a model or supplies semantic approval. Repository mappings must contain
the declared baseline; bundles transport unpublished commits.

Event pages return an opaque `cursor` bound to database, actor and filter,
numeric `sequence`, fixed watermark `through`, and `hasMore`. Start at `after:0`;
retain the returned cursor even for empty filtered pages. Reset when changing
filters. Foreign/ahead cursors are rejected. SDK subscriptions poll the transport
without model turns. Improved native workers wake on new messages or workflow
events, without periodic idle leader turns.

Pass `agentId` to `liteWorkerCommand`/`startLiteWorker` for local workers. The MCP
launcher binds it with `factory-mcp <db> --actor builder`; tool arguments cannot
select another actor or broaden verification policy. Default local MCP is the
trusted supervisor; its launch option `--verification-scopes` controls gates.
The trusted CLI accepts `factory workflow <db> @request.json`, with
`{tool,arguments,actor?,allowedScopes?}`. Worker identity is not a tool argument.

## Templates and knowledge

`listWorkflowTemplates`, `getWorkflowTemplate` and `buildWorkflowTask` expose
versioned contracts; `createTask` also enforces their context.

| Template | Required context |
| --- | --- |
| `verified-task` | Requirement and acceptance, derived from task fields by default |
| `repository-maintenance` | Repository, baseline, issue/PR, delivery policy |
| `integration-migration` | Components, compatibility contract, integration owner |
| `research-synthesis` | Question, source policy, coverage criteria |
| `continuous-improvement` | Backlog, success criteria, review triggers |

All use the same lifecycle and support dependent child tasks. Declare objective
gates, or explicitly choose `verificationPolicy:{mode:'review-only',reason:'...'}`
when no machine-evaluable condition applies. That is semantic acceptance, not an
objective test pass.

`curateKnowledge` requires an accepted candidate, exact artifact sources and
locations, applicability, a curator and an expected version. Search returns a
small set of current records with provenance. Unreviewed notes are not promoted
automatically.

## Matched comparison

`createWorkflowComparison` freezes runtime revisions/package hashes, original
repository commit, goal, acceptance criteria, evaluator, models, resources and
validation policy. Defaults are ten machines with ten agents per arm. Planning
does not launch anything or add a deadline.

Freeze the original `taskIds` (default `['mission']`) before starting either arm.
Provide two isolated `armRepositories` with the same source commit, separate
from the original repository. `launchWorkflowComparison` requires distinct
credentials scoped to those repositories, runtime bundle paths, and a private
directory. The common bootstrap pins source before either runtime starts. Each
arm has separate fleet journals, boards, artifacts and output namespaces.
A branch prefix is not a credential boundary. Credential scopes are configured
by the operator; the SDK does not independently verify their GitHub permissions.
Keep the other arm's results,
knowledge and evaluator hidden until evaluation.

Use the same independent evaluator and original task IDs for both arms.
`summarizeWorkflowComparison` retains pending/interrupted tasks in the denominator
and reports missing cost/token data as unknown. Interruption is separate from
failure; merge count alone is not the success metric.
